import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { Hono } from 'hono';
import type { AppBindings, AppContext } from '../types';
import { requireAdminSession } from './admin-security';
import { fetchFixSource } from './fix-source-fetch';
import { readOverrides, importFixOverride, isZipHeader, stagingImportOverridesEnv } from './overrides';
import { listCorrectionVoteTotals } from './correction-votes';
import { normalizeRemoteEntries, sortCorrectionCatalog, listCatalogMetadata, isDenuvoMetadata } from '../endpoints/fixes-catalog';

const CATALOG = 'https://generator.ryuu.lol/files/fixes.json';
const ROOT = '/panel-api/fix-import';
const PART_BYTES = 8 * 1024 ** 2;
const MAX_BYTES = 2 * 1024 ** 3;
const LEASE_MS = 10 * 60_000;
type Job = { app_id: string; position: number; name: string; source_url: string; filename: string;
  source_size: string | null; status: string; phase: string; attempts: number; processed_bytes: number;
  total_bytes: number; object_key: string | null; sha256: string | null; error: string | null;
  created_at: string; updated_at: string };
const timestamp = () => new Date().toISOString();
const hasOwnFixOrHidden = (entry: {hidden?: boolean;fixOverride?: unknown}|undefined) => Boolean(entry?.hidden || entry?.fixOverride);

export function validRyuuFixUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === 'https://generator.ryuu.lol' && !url.username && !url.password &&
      url.pathname.startsWith('/fixes/') && !url.search && !url.hash;
  } catch { return false; }
}
function extension(filename: string) {
  const match = filename.match(/\.(zip|rar)$/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}
// Stage has its own document and objects, even though MERLIN_FILES is shared.
export function fixImportStorage(env: AppBindings) {
  return env.ENVIRONMENT === 'staging' ? stagingImportOverridesEnv(env) : env;
}
function visible(job: Job) {
  const { source_url: _source, ...result } = job;
  return result;
}
export async function getFixImportDashboard(env: AppBindings) {
  const [control, result, overrides] = await Promise.all([
    env.merlin_db.prepare('SELECT lease_until FROM fix_import_control WHERE id=1').first<{lease_until:number}>(),
    env.merlin_db.prepare('SELECT * FROM fix_import_jobs ORDER BY position').all<Job>(),
    readOverrides(env),
  ]);
  const jobs = (result.results || []).filter(job=>!overrides[job.app_id]?.hidden && (job.status==='migrated' || !overrides[job.app_id]?.fixOverride));
  const summary = Object.fromEntries(['missing','queued','processing','migrated','failed','skipped'].map(status => [status, jobs.filter(job=>job.status===status).length]));
  return { isolated: env.ENVIRONMENT === 'staging', processing: (control?.lease_until||0)>Date.now(), summary, jobs: jobs.map(visible) };
}

async function fetchRyuuCatalog() {
  let upstreamStatus: number | undefined;
  try {
    const response = await fetchFixSource(CATALOG, { headers: { Accept:'application/json','User-Agent':'Merlin/2.0' },
      signal:AbortSignal.timeout(15_000) });
    upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Upstream HTTP ${response.status}`);
    }
    return normalizeRemoteEntries(await response.json());
  } catch (error) {
    console.warn('[FixImport] catalog-unavailable', { reason: error instanceof Error ? error.name : 'upstream_failure', status: upstreamStatus ?? null });
    throw new HTTPException(502, {message:'Não foi possível consultar a Ryuu agora. Tente novamente em alguns instantes. A lista atual foi mantida.'});
  }
}

export async function enqueueFixImports(c: AppContext) {
  const scanToken=crypto.randomUUID();
  const claimed=await c.env.merlin_db.prepare('UPDATE fix_import_control SET scan_token=?,scan_until=? WHERE id=1 AND scan_until<? RETURNING id')
    .bind(scanToken,Date.now()+5*60_000,Date.now()).first();
  if(!claimed)throw new HTTPException(409,{message:'O catálogo já está sendo consultado. Aguarde e atualize a lista.'});
  try {
  const entries = await fetchRyuuCatalog();
  const overrides = await readOverrides(c.env);
  const ids = entries.map(entry=>entry.appid);
  const [metadata, votes] = await Promise.all([listCatalogMetadata(c,ids),listCorrectionVoteTotals(c.env,ids)]);
  // Use the same sorting function and inputs as the Corrections screen.
  const sorted = sortCorrectionCatalog(entries.map(entry=>({ ...entry,
    name:overrides[entry.appid]?.name || entry.name,
    releaseDate:metadata.get(entry.appid)?.release_date || null,
    manualAddedAt:overrides[entry.appid]?.addedAt || null,
    hasDrm:isDenuvoMetadata(metadata.get(entry.appid)),
    fixes:entry.fixes.map(fix=>({...fix,...votes.get(entry.appid)})),
  })));
  const last = await c.env.merlin_db.prepare('SELECT COALESCE(MAX(position),0) AS position FROM fix_import_jobs').first<{position:number}>();
  let position=last?.position || 0;
  let ignored=0;
  const statements: D1PreparedStatement[]=[];
  const date=timestamp();
  for (const entry of sorted) {
    const fix=entry.fixes[0];
    if (!fix || hasOwnFixOrHidden(overrides[entry.appid]) || !validRyuuFixUrl(fix.href) || !extension(fix.filename)) {ignored++;continue;}
    statements.push(c.env.merlin_db.prepare(`INSERT OR IGNORE INTO fix_import_jobs
      (app_id,position,name,source_url,filename,source_size,status,phase,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'missing','missing',?,?) RETURNING app_id`).bind(entry.appid,++position,entry.name,fix.href,fix.filename.replace(/[\r\n"\\/]/g,'_'),fix.size||null,date,date));
  }
  // D1's unique constraints keep concurrent scans from duplicating a job.
  let queued=0;
  for(let i=0;i<statements.length;i+=50) {
    const results=await c.env.merlin_db.batch(statements.slice(i,i+50));
    queued+=results.reduce((sum,row)=>sum+row.results.length,0);
  }
  // Until the first manual selection, refresh the complete display order so
  // newly eligible games (e.g. manifest-only overrides) enter their proper place.
  const records=await c.env.merlin_db.prepare('SELECT app_id,position,status,attempts FROM fix_import_jobs ORDER BY position')
    .all<{app_id:string;position:number;status:string;attempts:number}>();
  if(records.results.length && records.results.every(job=>job.status==='missing' && job.attempts===0)) {
    const rank=new Map(sorted.map((entry,index)=>[entry.appid,index]));
    const ordered=[...records.results].sort((a,b)=>(rank.get(a.app_id)??Number.MAX_SAFE_INTEGER)-(rank.get(b.app_id)??Number.MAX_SAFE_INTEGER)||a.position-b.position);
    const changes=[c.env.merlin_db.prepare("UPDATE fix_import_jobs SET position=-position WHERE NOT EXISTS(SELECT 1 FROM fix_import_jobs WHERE status!='missing' OR attempts>0)")];
    for(let offset=0;offset<ordered.length;offset+=50) {
      const chunk=ordered.slice(offset,offset+50);
      changes.push(c.env.merlin_db.prepare(`WITH ranks(app_id,ordinal) AS (VALUES ${chunk.map(()=>'(?,?)').join(',')})
        UPDATE fix_import_jobs SET position=(SELECT ordinal FROM ranks WHERE ranks.app_id=fix_import_jobs.app_id)
        WHERE position<0 AND app_id IN (SELECT app_id FROM ranks)`)
        .bind(...chunk.flatMap((job,index)=>[job.app_id,offset+index+1])));
    }
    await c.env.merlin_db.batch(changes);
  }
  return {discovered:queued,ignored};
  } finally {
    await c.env.merlin_db.prepare('UPDATE fix_import_control SET scan_token=NULL,scan_until=0 WHERE id=1 AND scan_token=?').bind(scanToken).run();
  }
}

async function assertLease(env:AppBindings, token:string) {
  const row=await env.merlin_db.prepare('SELECT lease_token,lease_until FROM fix_import_control WHERE id=1').first<{lease_token:string;lease_until:number}>();
  if(row?.lease_token!==token || row.lease_until<=Date.now()) throw new Error('A tarefa perdeu a reserva de processamento.');
}
class FixImportCancelled extends Error {
  constructor() { super('O jogo foi retirado da fila de importação.'); }
}
async function assertJob(env:AppBindings, token:string, job:Job) {
  await assertLease(env,token);
  const current=await env.merlin_db.prepare('SELECT status,attempts FROM fix_import_jobs WHERE app_id=?')
    .bind(job.app_id).first<{status:string;attempts:number}>();
  if(current?.status!=='processing' || current.attempts!==job.attempts)throw new FixImportCancelled();
}
async function setJob(env:AppBindings, token:string, job:Job, status:string, phase:string, error:string|null=null, expectedStatus='processing') {
  return env.merlin_db.prepare(`UPDATE fix_import_jobs SET status=?,phase=?,error=?,updated_at=? WHERE app_id=? AND attempts=? AND status=?
    AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
    .bind(status,phase,error,timestamp(),job.app_id,job.attempts,expectedStatus,token,Date.now()).first<{app_id:string}>();
}
function selectedAppIds(value:unknown) {
  if(!Array.isArray(value)||!value.length||value.length>200||value.some(id=>typeof id!=='string'||!/^\d+$/.test(id)))
    throw new HTTPException(400,{message:'Selecione até 200 jogos.'});
  return [...new Set(value as string[])];
}
export async function resetFixImports(env:AppBindings, selection:unknown) {
  const ids=selectedAppIds(selection);
  const marks=ids.map(()=>'?').join(',');
  const previous=await env.merlin_db.prepare(`SELECT app_id,object_key FROM fix_import_jobs WHERE app_id IN (${marks})
    AND status IN ('queued','processing','failed') AND phase!='saving'`).bind(...ids).all<{app_id:string;object_key:string|null}>();
  const previousObjects=new Map(previous.results.map(row=>[row.app_id,row.object_key]));
  const statements=ids.map(id=>env.merlin_db.prepare(`UPDATE fix_import_jobs
    SET status='missing',phase='missing',processed_bytes=0,total_bytes=0,object_key=NULL,sha256=NULL,error=NULL,updated_at=?
    WHERE app_id=? AND status IN ('queued','processing','failed') AND phase!='saving' RETURNING app_id`).bind(timestamp(),id));
  let reset=0;
  const obsoleteObjects:string[]=[];
  for(let offset=0;offset<statements.length;offset+=50) {
    const results=await env.merlin_db.batch(statements.slice(offset,offset+50));
    reset+=results.reduce((sum,row)=>sum+row.results.length,0);
    for(const row of results)for(const result of row.results as Array<{app_id:string}>) {
      const key=previousObjects.get(result.app_id);
      if(key)obsoleteObjects.push(key);
    }
  }
  await Promise.all(obsoleteObjects.map(key=>env.MERLIN_FILES.delete(key).catch(()=>{})));
  return {success:true,reset,unchanged:ids.length-reset};
}
export function validFixHeader(bytes:Uint8Array, ext:string) {
  if(ext==='zip') return isZipHeader(bytes);
  return bytes.length>=8 && [82,97,114,33,26,7].every((byte,index)=>bytes[index]===byte) &&
    (bytes[6]===0 || (bytes[6]===1 && bytes[7]===0));
}

async function downloadFix(env:AppBindings, job:Job, token:string) {
  if(!validRyuuFixUrl(job.source_url)) throw new Error('Link da correção inválido.');
  const ext=extension(job.filename);
  if(!ext) throw new Error('O arquivo precisa ser ZIP ou RAR.');
  const secret=env.RYUU_AUTH_CODE?.trim();
  if(!secret) throw new Error('A autenticação da Ryuu não está configurada.');
  const relative=`${job.app_id}/fixes/${env.ENVIRONMENT==='staging'?'_staging/':''}ryuu-import-${crypto.randomUUID()}.${ext}`;
  const key=relative;
  const url=new URL(job.source_url);url.searchParams.set('auth_code',secret);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),120_000);
  const cancellationCheck=setInterval(()=>{
    void assertJob(env,token,job).catch(()=>controller.abort());
  },2000);
  let upload:R2MultipartUpload|undefined;
  try {
    await assertJob(env,token,job);
    const response=await fetchFixSource(url,{signal:controller.signal,headers:{'User-Agent':'Merlin/2.0',Accept:'application/zip,application/vnd.rar,application/octet-stream'}});
    if(!response.ok || !response.body) throw new Error(`A Ryuu respondeu com HTTP ${response.status}.`);
    const declared=Number(response.headers.get('content-length')||0);
    if(!Number.isSafeInteger(declared)||declared<0||declared>MAX_BYTES) throw new Error('Arquivo acima do limite de 2 GiB.');
    await assertJob(env,token,job);
    await env.merlin_db.prepare(`UPDATE fix_import_jobs SET processed_bytes=0,total_bytes=?,phase=?,updated_at=? WHERE app_id=? AND attempts=? AND status='processing'
      AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?)`).bind(declared,'downloading',timestamp(),job.app_id,job.attempts,token,Date.now()).run();
    upload=await env.MERLIN_FILES.createMultipartUpload(key,{httpMetadata:{contentType:ext==='zip'?'application/zip':'application/vnd.rar',cacheControl:'no-store'}});
    const hash=createHash('sha256');
    const parts:R2UploadedPart[]=[];
    const reader=response.body.getReader();
    let count=0, buffer=new Uint8Array(PART_BYTES), used=0, checked=false, lastProgress=Date.now();
    try {
      while(true) {
        const {value,done}=await reader.read();
        if(done) break;
        count+=value.byteLength;
        if(count>MAX_BYTES) throw new Error('Arquivo acima do limite de 2 GiB.');
        hash.update(value);
        let offset=0;
        while(offset<value.length) {
          const size=Math.min(buffer.length-used,value.length-offset);
          buffer.set(value.subarray(offset,offset+size),used);used+=size;offset+=size;
          if(!checked && used>=8) {
            if(!validFixHeader(buffer.subarray(0,used),ext)) throw new Error('O conteúdo recebido não é um arquivo ZIP/RAR válido.');
            checked=true;
          }
          if(used===buffer.length) {
            parts.push(await upload.uploadPart(parts.length+1,buffer));
            buffer=new Uint8Array(PART_BYTES);used=0;
          }
        }
        if(Date.now()-lastProgress>4000) {
          await assertJob(env,token,job);
          await env.merlin_db.prepare(`UPDATE fix_import_jobs SET processed_bytes=?,updated_at=? WHERE app_id=? AND attempts=? AND status='processing'
            AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?)`).bind(count,timestamp(),job.app_id,job.attempts,token,Date.now()).run();lastProgress=Date.now();
        }
      }
    } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
    if(!checked || count<8 || (declared && declared!==count)) throw new Error('O arquivo recebido está vazio ou incompleto.');
    if(used) parts.push(await upload.uploadPart(parts.length+1,buffer.subarray(0,used)));
    await assertJob(env,token,job);
    await upload.complete(parts);
    const sha256=hash.digest('hex');
    const stored=await env.merlin_db.prepare(`UPDATE fix_import_jobs SET object_key=?,sha256=?,processed_bytes=?,total_bytes=?,phase=?,updated_at=? WHERE app_id=? AND attempts=? AND status='processing'
      AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
      .bind(relative,sha256,count,count,'publishing',timestamp(),job.app_id,job.attempts,token,Date.now()).first();
    if(!stored) {
      await env.MERLIN_FILES.delete(key).catch(()=>{});
      throw new FixImportCancelled();
    }
    return {relative,size:count};
  } catch(error) {
    if(upload) await upload.abort().catch(()=>{});
    if(controller.signal.aborted) {
      await assertJob(env,token,job);
      throw new Error('O download demorou demais. Tente novamente.');
    }
    // Never persist the URL, secret or raw upstream error in the dashboard.
    if(error instanceof Error && !error.message.includes(secret) && !error.message.includes('http')) throw error;
    throw new Error('Não foi possível concluir o download da Ryuu. Tente novamente.');
  } finally {clearTimeout(timeout);clearInterval(cancellationCheck);}
}

export async function processFixImportQueue(env:AppBindings) {
  const token=crypto.randomUUID();
  const now=Date.now();
  const lock=await env.merlin_db.prepare(`UPDATE fix_import_control SET lease_token=?,lease_until=?
    WHERE id=1 AND lease_until<? AND EXISTS(SELECT 1 FROM fix_import_jobs WHERE status IN ('queued','processing')) RETURNING id`).bind(token,now+LEASE_MS,now).first();
  if(!lock)return;
  try {
    const interrupted=await env.merlin_db.prepare("UPDATE fix_import_jobs SET status='failed',phase='failed',error='O processamento foi interrompido. Tente novamente.',updated_at=? WHERE status='processing' AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING *")
      .bind(timestamp(),token,Date.now()).all<Job>();
    if(interrupted.results.length) {
      const entries=await readOverrides(env);
      for(const job of interrupted.results)if(job.object_key && entries[job.app_id]?.fixOverride?.file===job.object_key)await setJob(env,token,job,'migrated','migrated',null,'failed');
    }
    for(let processed=0;processed<5 && Date.now()-now<45_000;processed++) {
      const candidate=await env.merlin_db.prepare("SELECT app_id,attempts FROM fix_import_jobs WHERE status='queued' ORDER BY position LIMIT 1").first<{app_id:string;attempts:number}>();
      if(!candidate)break;
      try {
        const job=await env.merlin_db.prepare("UPDATE fix_import_jobs SET status='processing',phase='checking',attempts=attempts+1,error=NULL,updated_at=? WHERE app_id=? AND attempts=? AND status='queued' AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING *")
          .bind(timestamp(),candidate.app_id,candidate.attempts,token,Date.now()).first<Job>();
        if(!job)continue;
        await assertJob(env,token,job);
        const existing=(await readOverrides(env))[job.app_id];
        if(job.object_key && existing?.fixOverride?.file===job.object_key) {
          await setJob(env,token,job,'migrated','migrated');continue;
        }
        if(hasOwnFixOrHidden(existing)) {
          await setJob(env,token,job,'skipped','skipped',existing?.hidden?'Jogo oculto no Merlin.':'O jogo já tem um fix próprio.');continue;
        }
        const storage=fixImportStorage(env);
        const previous=(await readOverrides(storage))[job.app_id];
        if(previous?.hidden||previous?.fixOverride){await setJob(env,token,job,'skipped','skipped','O jogo já foi importado ou está oculto.');continue;}
        // Retry may reuse a completely downloaded object from an interrupted publication.
        const cached=job.object_key && job.sha256 ? await env.MERLIN_FILES.head(job.object_key) : null;
        const file=cached && cached.size===job.total_bytes ? {relative:job.object_key!,size:cached.size} : await downloadFix(env,job,token);
        await assertLease(env,token);
        const current=(await readOverrides(env))[job.app_id];
        if(hasOwnFixOrHidden(current)) {await setJob(env,token,job,'skipped','skipped','O fix foi alterado ou o jogo foi ocultado durante o download.');continue;}
        const saving=await setJob(env,token,job,'processing','saving');
        if(!saving)throw new FixImportCancelled();
        const outcome=await importFixOverride(storage,job.app_id,job.name,{enabled:true,file:file.relative,gameName:job.name,filename:job.filename,size:`${(file.size/1024**2).toFixed(1)} MB`},env.ENVIRONMENT==='staging'?current:undefined);
        await setJob(env,token,job,outcome==='imported'?'migrated':'skipped',outcome==='imported'?'migrated':'skipped',outcome==='imported'?null:'O jogo foi ocultado ou já possui override.');
      } catch(error) {
        if(error instanceof FixImportCancelled)continue;
        // A concurrent reset may have won after the claim but before the error was recorded.
        const current=await env.merlin_db.prepare('SELECT status,attempts FROM fix_import_jobs WHERE app_id=?').bind(candidate.app_id).first<{status:string;attempts:number}>();
        if(current?.status!=='processing'||current.attempts!==candidate.attempts+1)continue;
        const message=error instanceof Error?error.message:'Falha durante a importação.';
        const claimed={app_id:candidate.app_id,attempts:candidate.attempts+1} as Job;
        await setJob(env,token,claimed,'failed','failed',message.includes('http')||message.includes('auth_code')?'Falha na comunicação com a origem.':message.slice(0,250));
        // A worker that lost its lease must not select or update another job.
        await assertLease(env,token);
      }
    }
  } finally {
    await env.merlin_db.prepare('UPDATE fix_import_control SET lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=?').bind(token).run();
  }
}

export function registerFixImportRoutes(app:Hono<{Bindings:AppBindings}>) {
  app.get(ROOT,async c=>{await requireAdminSession(c);return c.json(await getFixImportDashboard(c.env));});
  app.post(`${ROOT}/reset`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const body=await c.req.json().catch(()=>null);
    return c.json(await resetFixImports(c.env,body?.appIds));
  });
  app.post(`${ROOT}/scan`,async c=>{await requireAdminSession(c,{mutate:true});return c.json(await enqueueFixImports(c));});
  app.post(`${ROOT}/enqueue`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const body=await c.req.json().catch(()=>null);
    if(!body||!Array.isArray(body.appIds)||!body.appIds.length||body.appIds.length>200||body.appIds.some((id:unknown)=>typeof id!=='string'||!/^\d+$/.test(id)))throw new HTTPException(400,{message:'Selecione até 200 jogos.'});
    const overrides=await readOverrides(c.env);
    const ids=[...new Set(body.appIds as string[])].filter(id=>!hasOwnFixOrHidden(overrides[id]));
    const statements=ids.map(id=>c.env.merlin_db.prepare("UPDATE fix_import_jobs SET status='queued',phase='queued',error=NULL,updated_at=? WHERE app_id=? AND status IN ('missing','failed') RETURNING app_id").bind(timestamp(),id));
    let queued=0;
    for(let i=0;i<statements.length;i+=50) {const results=await c.env.merlin_db.batch(statements.slice(i,i+50));queued+=results.reduce((sum,row)=>sum+row.results.length,0);}
    return c.json({success:true,queued});
  });
  app.post(`${ROOT}/:appId/retry`,async c=>{
    await requireAdminSession(c,{mutate:true});const id=c.req.param('appId');
    if(!/^\d+$/.test(id))throw new HTTPException(400,{message:'AppID inválido.'});
    if(hasOwnFixOrHidden((await readOverrides(c.env))[id]))throw new HTTPException(409,{message:'O jogo está oculto ou já possui fix próprio.'});
    const job=await c.env.merlin_db.prepare("UPDATE fix_import_jobs SET status='queued',phase='queued',error=NULL,updated_at=? WHERE app_id=? AND status='failed' RETURNING app_id").bind(timestamp(),id).first();
    if(!job)throw new HTTPException(409,{message:'Somente tarefas com falha podem ser tentadas novamente.'});
    return c.json({success:true});
  });
}
