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
const PART_CONCURRENCY = 4;
const MAX_BYTES = 2 * 1024 ** 3;
const LEASE_MS = 10 * 60_000;
type Job = { app_id: string; position: number; name: string; source_url: string; filename: string; source_tags: string | null;
  source_size: string | null; status: string; phase: string; attempts: number; processed_bytes: number;
  total_bytes: number; object_key: string | null; upload_id: string | null; upload_parts: string | null; sha256: string | null; error: string | null;
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
  const { source_url, source_tags, upload_id: _upload, upload_parts: _parts, ...result } = job;
  return { ...result, tags: source_tags ? JSON.parse(source_tags) as string[] : null,
    directDownloadUrl: validRyuuFixUrl(source_url) ? source_url : null };
}
export async function getFixImportDashboard(env: AppBindings) {
  const [control, result, overrides] = await Promise.all([
    env.merlin_db.prepare('SELECT lease_until FROM fix_import_control WHERE id=1').first<{lease_until:number}>(),
    env.merlin_db.prepare('SELECT * FROM fix_import_jobs ORDER BY position').all<Job>(),
    readOverrides(env),
  ]);
  const jobs = (result.results || []).filter(job=>{
    const override=overrides[job.app_id];
    const awaitingPublication=Boolean(job.object_key) &&
      (job.phase==='local_publishing'||job.phase==='local_finalizing'||job.phase==='local_queued');
    return awaitingPublication || (!override?.hidden && (job.status==='migrated' || !override?.fixOverride));
  });
  const summary = Object.fromEntries(['missing','queued','processing','migrated','failed','skipped'].map(status => [status, jobs.filter(job=>job.status===status).length]));
  return { isolated: env.ENVIRONMENT === 'staging', processing: (control?.lease_until||0)>Date.now(),
    localQueued: jobs.filter(job=>job.status==='queued'&&job.phase==='local_queued').length, summary, jobs: jobs.map(visible) };
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
    return normalizeRemoteEntries(await response.json(), true);
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
    const nextPosition = ++position;
    statements.push(c.env.merlin_db.prepare(`INSERT INTO fix_import_jobs
      (app_id,position,name,source_url,filename,source_size,source_tags,status,phase,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'missing','missing',?,?)
      ON CONFLICT(app_id) DO UPDATE SET source_tags=excluded.source_tags
      WHERE fix_import_jobs.source_url=excluded.source_url
        AND fix_import_jobs.source_tags IS NOT excluded.source_tags
      RETURNING position=? AS discovered`).bind(entry.appid,nextPosition,entry.name,fix.href,
        fix.filename.replace(/[\r\n"\\/]/g,'_'),fix.size||null,JSON.stringify(fix.badges||[]),date,date,nextPosition));
  }
  // D1's unique constraints keep concurrent scans from duplicating a job.
  let queued=0;
  for(let i=0;i<statements.length;i+=50) {
    const results=await c.env.merlin_db.batch<{discovered:number}>(statements.slice(i,i+50));
    queued+=results.reduce((sum,row)=>sum+row.results.filter(job=>job.discovered===1).length,0);
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
  let reset=0;
  for (const id of ids) {
    const job=await env.merlin_db.prepare('SELECT * FROM fix_import_jobs WHERE app_id=?').bind(id).first<Job>();
    if (!job || !['queued','processing','failed'].includes(job.status)) continue;
    if (['saving','local_finalizing','local_publishing'].includes(job.phase) ||
        (job.phase==='local_queued' && job.object_key && !job.upload_id)) continue;
    const changed=await env.merlin_db.prepare(`UPDATE fix_import_jobs
      SET status='missing',phase='missing',processed_bytes=0,total_bytes=0,object_key=NULL,upload_id=NULL,
        upload_parts=NULL,sha256=NULL,error=NULL,updated_at=?
      WHERE app_id=? AND attempts=? AND status=? AND phase=? AND object_key IS ? AND upload_id IS ?
      RETURNING app_id`).bind(timestamp(),id,job.attempts,job.status,job.phase,job.object_key,job.upload_id).first();
    if (!changed) continue;
    reset++;
    if (job.object_key && job.upload_id) {
      await env.MERLIN_FILES.resumeMultipartUpload(job.object_key,job.upload_id).abort().catch(()=>{});
    }
    if (job.object_key && (await readOverrides(env))[id]?.fixOverride?.file!==job.object_key) {
      await env.MERLIN_FILES.delete(job.object_key).catch(()=>{});
    }
  }
  return {success:true,reset,unchanged:ids.length-reset};
}
export function validFixHeader(bytes:Uint8Array, ext:string) {
  if(ext==='zip') return isZipHeader(bytes);
  return bytes.length>=8 && [82,97,114,33,26,7].every((byte,index)=>bytes[index]===byte) &&
    (bytes[6]===0 || (bytes[6]===1 && bytes[7]===0));
}

async function assertLocalLease(env:AppBindings, appId:string, token:string) {
  if(!token)throw new HTTPException(409,{message:'A sessão da fila local expirou. Inicie a fila novamente.'});
  const control=await env.merlin_db.prepare('SELECT lease_token,lease_until FROM fix_import_control WHERE id=1')
    .first<{lease_token:string|null;lease_until:number}>();
  if(control?.lease_token!==token||control.lease_until<=Date.now())
    throw new HTTPException(409,{message:'A sessão da fila local expirou. Inicie a fila novamente.'});
  const job=await env.merlin_db.prepare('SELECT * FROM fix_import_jobs WHERE app_id=?').bind(appId).first<Job>();
  if(!job||job.status!=='processing'||!job.phase.startsWith('local_'))
    throw new HTTPException(409,{message:'Este jogo não está sendo processado pela fila local.'});
  return job;
}

async function releaseLocalLease(env:AppBindings, token:string) {
  if(token)await env.merlin_db.prepare('UPDATE fix_import_control SET lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=?').bind(token).run();
}

async function claimLocalNext(env:AppBindings, requestedToken:string) {
  let token=requestedToken;
  if(token) {
    const renewed=await env.merlin_db.prepare('UPDATE fix_import_control SET lease_until=? WHERE id=1 AND lease_token=? AND lease_until>? RETURNING id')
      .bind(Date.now()+LEASE_MS,token,Date.now()).first();
    if(!renewed)throw new HTTPException(409,{message:'A sessão da fila local expirou. Inicie a fila novamente.'});
  } else {
    token=crypto.randomUUID();
    const lock=await env.merlin_db.prepare('UPDATE fix_import_control SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING id')
      .bind(token,Date.now()+LEASE_MS,Date.now()).first();
    if(!lock)throw new HTTPException(409,{message:'Já existe uma importação em andamento.'});
  }

  const active=await env.merlin_db.prepare("SELECT * FROM fix_import_jobs WHERE status='processing' ORDER BY position LIMIT 1").first<Job>();
  if(active) {
    if(!active.phase.startsWith('local_')) {
      await env.merlin_db.prepare(`UPDATE fix_import_jobs SET status='failed',phase='failed',error='O processamento anterior foi interrompido. Tente novamente.',updated_at=?
        WHERE app_id=? AND status='processing' AND attempts=?`).bind(timestamp(),active.app_id,active.attempts).run();
    } else {
      return {job:visible(active),leaseToken:token};
    }
  }

  while(true) {
    const candidate=await env.merlin_db.prepare("SELECT * FROM fix_import_jobs WHERE status='queued' AND phase='local_queued' ORDER BY position LIMIT 1").first<Job>();
    if(!candidate) {
      await releaseLocalLease(env,token);
      return {job:null,leaseToken:null};
    }
    const overrides=await readOverrides(env);
    if(!candidate.object_key && hasOwnFixOrHidden(overrides[candidate.app_id])) {
      await env.merlin_db.prepare(`UPDATE fix_import_jobs SET status='skipped',phase='skipped',error=?,updated_at=?
        WHERE app_id=? AND status='queued' AND phase='local_queued'`)
        .bind(overrides[candidate.app_id]?.hidden?'Jogo oculto no Merlin.':'O jogo já tem um fix próprio.',timestamp(),candidate.app_id).run();
      continue;
    }
    const job=await env.merlin_db.prepare(`UPDATE fix_import_jobs SET status='processing',phase=CASE
        WHEN object_key IS NOT NULL AND upload_id IS NULL THEN 'local_publishing'
        WHEN object_key IS NOT NULL AND upload_id IS NOT NULL THEN 'local_uploading'
        ELSE 'local_downloading' END,attempts=attempts+1,error=NULL,updated_at=?
      WHERE app_id=? AND status='queued' AND phase='local_queued' RETURNING *`).bind(timestamp(),candidate.app_id).first<Job>();
    if(job)return {job:visible(job),leaseToken:token};
  }
}

async function downloadLocalSource(c:AppContext, appId:string, token:string) {
  const job=await assertLocalLease(c.env,appId,token);
  if(!['local_downloading','local_uploading','local_upload_ready'].includes(job.phase))throw new HTTPException(409,{message:'O jogo não está na fila local.'});
  const secret=c.env.RYUU_AUTH_CODE?.trim();
  if(!secret)throw new HTTPException(502,{message:'A autenticação da Ryuu não está configurada.'});
  if(!validRyuuFixUrl(job.source_url))throw new HTTPException(502,{message:'O link do arquivo é inválido.'});
  const url=new URL(job.source_url);url.searchParams.set('auth_code',secret);
  const started=Date.now();
  let response:Response;
  try {
    response=await fetchFixSource(url,{headers:{'User-Agent':'Merlin/2.0',Accept:'application/zip,application/vnd.rar,application/octet-stream'}});
  } catch {
    throw new HTTPException(502,{message:'Não foi possível baixar o arquivo da Ryuu.'});
  }
  if(!response.ok||!response.body) {
    await response.body?.cancel().catch(()=>{});
    console.warn('[FixImport] local source request failed',{appId,status:response.status});
    throw new HTTPException(502,{message:`Ryuu respondeu HTTP ${response.status} ou não retornou um arquivo.`});
  }
  const upstreamMs=Date.now()-started;
  const declared=Number(response.headers.get('content-length')||0);
  if(!Number.isSafeInteger(declared)||declared<0||declared>MAX_BYTES) {
    await response.body.cancel().catch(()=>{});
    throw new HTTPException(413,{message:'O arquivo ultrapassa o limite de 2 GiB.'});
  }
  const changed=await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET phase='local_downloading',processed_bytes=0,
    total_bytes=?,upload_id=NULL,upload_parts=NULL,object_key=NULL,sha256=NULL,updated_at=? WHERE app_id=? AND status='processing' AND attempts=? AND phase=? AND upload_id IS ?
    AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
    .bind(declared,timestamp(),appId,job.attempts,job.phase,job.upload_id,token,Date.now()).first();
  if(!changed) {
    await response.body.cancel().catch(()=>{});
    throw new HTTPException(409,{message:'A sessão da fila local expirou. Inicie a fila novamente.'});
  }
  if(job.upload_id&&job.object_key)await c.env.MERLIN_FILES.resumeMultipartUpload(job.object_key,job.upload_id).abort().catch(()=>{});
  const headers=new Headers();
  headers.set('cache-control','no-store');
  headers.set('server-timing',`ryuu;dur=${upstreamMs}`);
  console.info('[FixImport] source headers',{appId,attempt:job.attempts,upstreamMs,bytes:declared});
  headers.set('content-type',extension(job.filename)==='zip'?'application/zip':'application/vnd.rar');
  headers.set('content-disposition',`attachment; filename="${job.filename}"`);
  if(declared)headers.set('content-length',String(declared));
  return new Response(response.body,{status:200,headers});
}

async function completeLocalDownload(c:AppContext, appId:string, token:string, body:any) {
  const job=await assertLocalLease(c.env,appId,token);
  if(!['local_downloading','local_upload_ready','local_uploading'].includes(job.phase))
    throw new HTTPException(409,{message:'O arquivo não está pronto para envio.'});
  const bytes=Number(body?.bytes);
  if(!Number.isSafeInteger(bytes)||bytes<8||bytes>MAX_BYTES||job.total_bytes>0&&bytes!==job.total_bytes)
    throw new HTTPException(400,{message:'O tamanho do arquivo salvo não confere com o catálogo.'});
  const ext=extension(job.filename);
  const signature=typeof body?.signature==='string'&&/^(?:[0-9a-f]{2}){8}$/i.test(body.signature)
    ? Uint8Array.from(body.signature.match(/.{2}/g)!.map((value:string)=>parseInt(value,16))) : new Uint8Array();
  if(!ext||!validFixHeader(signature,ext))throw new HTTPException(400,{message:'O arquivo local não é um ZIP/RAR válido.'});
  const digest=typeof body?.sha256==='string'&&/^[a-f0-9]{64}$/.test(body.sha256)?body.sha256:null;
  const resume=Boolean(digest && digest===job.sha256 && job.upload_id && job.object_key);
  const changed=await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET phase=?,processed_bytes=?,total_bytes=?,
    sha256=?,upload_id=?,upload_parts=?,object_key=?,updated_at=? WHERE app_id=? AND attempts=? AND status='processing'
    AND phase=? AND upload_id IS ?
    AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
    .bind(resume?'local_uploading':'local_upload_ready',resume?job.processed_bytes:bytes,bytes,digest,
      resume?job.upload_id:null,resume?job.upload_parts:null,resume?job.object_key:null,timestamp(),appId,job.attempts,job.phase,job.upload_id,token,Date.now()).first();
  if(!changed)throw new HTTPException(409,{message:'A sessão da fila local expirou. Inicie a fila novamente.'});
  if(!resume && job.upload_id && job.object_key) {
    await c.env.MERLIN_FILES.resumeMultipartUpload(job.object_key,job.upload_id).abort().catch(()=>{});
  }
  const downloadMs=Number(body?.downloadMs);
  if(Number.isFinite(downloadMs)&&downloadMs>=0) {
    console.info('[FixImport] archive saved',{appId,attempt:job.attempts,bytes,downloadMs});
  }
  return {success:true,bytes};
}

function savedParts(job:Job):R2UploadedPart[] {
  return job.upload_parts ? JSON.parse(job.upload_parts) as R2UploadedPart[] : [];
}

async function failLocalJob(env:AppBindings, appId:string, token:string) {
  const job=await assertLocalLease(env,appId,token);
  const message=job.phase==='local_publishing'
    ? 'Não foi possível finalizar o cadastro. Tente novamente.'
    : job.phase==='local_uploading'||job.phase==='local_upload_ready'||job.phase==='local_finalizing'
      ? 'Falha no envio ao R2. O arquivo local foi mantido.'
      : 'Falha ao preparar ou baixar o arquivo para o PC.';
  const changed=await env.merlin_db.prepare(`UPDATE fix_import_jobs SET status='failed',error=?,updated_at=?
    WHERE app_id=? AND status='processing' AND attempts=? AND phase=?
    AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
    .bind(message,timestamp(),appId,job.attempts,job.phase,token,Date.now()).first();
  if(!changed)throw new HTTPException(409,{message:'A sessão da fila mudou. Inicie novamente.'});
  return {success:true};
}

async function uploadLocalPart(c:AppContext, appId:string, token:string, partNumber:number) {
  const job=await assertLocalLease(c.env,appId,token);
  if(job.phase!=='local_uploading'||!job.upload_id||!job.object_key)throw new HTTPException(409,{message:'Inicie o envio do arquivo antes de enviar partes.'});
  const count=Math.ceil(job.total_bytes/PART_BYTES);
  if(!Number.isInteger(partNumber)||partNumber<1||partNumber>count)throw new HTTPException(400,{message:'Número de parte inválido.'});
  const expected=Math.min(PART_BYTES,job.total_bytes-(partNumber-1)*PART_BYTES);
  const headerLength=Number(c.req.header('content-length')||0);
  if(headerLength&&headerLength!==expected)throw new HTTPException(400,{message:'O tamanho desta parte não confere.'});
  const previous=savedParts(job);
  if(partNumber<=previous.length)return {success:true,...previous[partNumber-1]};
  if(partNumber!==previous.length+1)throw new HTTPException(409,{message:'Envie as partes na ordem da fila.'});
  const readStart=Date.now();
  const bytes=new Uint8Array(await c.req.arrayBuffer());
  const receiveMs=Date.now()-readStart;
  if(bytes.byteLength!==expected)throw new HTTPException(400,{message:'O tamanho desta parte não confere.'});
  const ext=extension(job.filename);
  if(partNumber===1&&(!ext||!validFixHeader(bytes.subarray(0,8),ext)))throw new HTTPException(400,{message:'O arquivo local não é um ZIP/RAR válido.'});
  const r2Start=Date.now();
  let part:R2UploadedPart;
  try {
    part=await c.env.MERLIN_FILES.resumeMultipartUpload(job.object_key,job.upload_id).uploadPart(partNumber,bytes);
  } catch(error) {
    console.warn('[FixImport] part failed',{appId,attempt:job.attempts,partNumber,receiveMs,r2Ms:Date.now()-r2Start});
    if(isMissingUpload(error))await clearExpiredUpload(c.env,job,token);
    throw new HTTPException(502,{message:`O R2 não confirmou a parte ${partNumber}.`});
  }
  const r2Ms=Date.now()-r2Start;
  const changed=await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET processed_bytes=?,upload_parts=?,updated_at=?
    WHERE app_id=? AND status='processing' AND phase='local_uploading' AND attempts=? AND upload_id=? AND upload_parts IS ?
    AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
    .bind((partNumber-1)*PART_BYTES+bytes.byteLength,JSON.stringify([...previous,part]),timestamp(),
      appId,job.attempts,job.upload_id,job.upload_parts,token,Date.now()).first();
  if(!changed)throw new HTTPException(409,{message:'A sessão da fila mudou. Inicie novamente.'});
  console.info('[FixImport] part confirmed',{appId,attempt:job.attempts,partNumber,bytes:bytes.byteLength,receiveMs,r2Ms});
  return {success:true,...part,receiveMs,r2Ms};
}

function isMissingUpload(error:unknown) {
  return error instanceof Error && /NoSuchUpload|multipart upload does not exist|specified multipart upload does not exist/i.test(error.message);
}

async function clearExpiredUpload(env:AppBindings,job:Job,token:string) {
  await env.merlin_db.prepare(`UPDATE fix_import_jobs SET phase='local_upload_ready',object_key=NULL,upload_id=NULL,upload_parts=NULL,
    processed_bytes=0,updated_at=? WHERE app_id=? AND status='processing' AND attempts=? AND phase=? AND upload_id=?
    AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?)`)
    .bind(timestamp(),job.app_id,job.attempts,job.phase,job.upload_id,token,Date.now()).run();
}

async function completeLocalUpload(c:AppContext, appId:string, token:string) {
  let job=await assertLocalLease(c.env,appId,token);
  if(!job.object_key||!['local_uploading','local_finalizing','local_publishing'].includes(job.phase))
    throw new HTTPException(409,{message:'Não há um envio ao R2 para concluir.'});
  const key=job.object_key;
  if(job.phase!=='local_publishing') {
    const parts=savedParts(job);
    if(!job.upload_id||parts.length!==Math.ceil(job.total_bytes/PART_BYTES))
      throw new HTTPException(400,{message:'O envio está incompleto.'});
    if(job.phase==='local_uploading') {
      const finalizing=await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET phase='local_finalizing',updated_at=?
        WHERE app_id=? AND status='processing' AND attempts=? AND upload_id=? AND phase='local_uploading'
        AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING *`)
        .bind(timestamp(),appId,job.attempts,job.upload_id,token,Date.now()).first<Job>();
      if(!finalizing)throw new HTTPException(409,{message:'A sessão da fila mudou. Inicie novamente.'});
      job=finalizing;
    }
    const started=Date.now();
    let uploaded=await c.env.MERLIN_FILES.head(key);
    if(!uploaded) {
      try {
        uploaded=await c.env.MERLIN_FILES.resumeMultipartUpload(key,job.upload_id!).complete(parts);
      } catch(error) {
        uploaded=await c.env.MERLIN_FILES.head(key);
        if(!uploaded) {
          if(isMissingUpload(error))await clearExpiredUpload(c.env,job,token);
          throw new HTTPException(502,{message:'Não foi possível finalizar o envio ao R2.'});
        }
      }
    }
    if(uploaded.size!==job.total_bytes)throw new HTTPException(502,{message:'O tamanho salvo no R2 não confere.'});
    console.info('[FixImport] object completed',{appId,attempt:job.attempts,bytes:uploaded.size,completeMs:Date.now()-started});
    const ready=await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET phase='local_publishing',upload_id=NULL,
      upload_parts=NULL,processed_bytes=total_bytes,updated_at=?
      WHERE app_id=? AND status='processing' AND attempts=? AND phase='local_finalizing' AND upload_id=?
      AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING *`)
      .bind(timestamp(),appId,job.attempts,job.upload_id,token,Date.now()).first<Job>();
    if(!ready)throw new HTTPException(409,{message:'A sessão da fila mudou. Inicie novamente.'});
    job=ready;
  }

  const started=Date.now();
  const current=(await readOverrides(c.env))[appId];
  let outcome:'imported'|'hidden'|'existing';
  if(current?.fixOverride?.file===key)outcome='imported';
  else if(hasOwnFixOrHidden(current))outcome=current?.hidden?'hidden':'existing';
  else {
    const object=await c.env.MERLIN_FILES.head(key);
    if(object?.size!==job.total_bytes)throw new HTTPException(502,{message:'O arquivo enviado não está disponível no R2.'});
    try {
      outcome=await importFixOverride(fixImportStorage(c.env),appId,job.name,{enabled:true,file:key,gameName:job.name,
        filename:job.filename,size:`${(job.total_bytes/1024**2).toFixed(1)} MB`},c.env.ENVIRONMENT==='staging'?current:undefined);
    } catch {
      console.warn('[FixImport] override failed',{appId,attempt:job.attempts,publishMs:Date.now()-started});
      throw new HTTPException(502,{message:'O arquivo está no R2. Tente cadastrar o fix novamente.'});
    }
  }
  const status=outcome==='imported'?'migrated':'skipped';
  const finished=await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET status=?,phase=?,error=?,object_key=?,upload_id=NULL,upload_parts=NULL,updated_at=?
    WHERE app_id=? AND status='processing' AND phase='local_publishing' AND attempts=? AND object_key=?
    AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
    .bind(status,status,outcome==='imported'?null:'O jogo foi ocultado ou já possui override.',outcome==='imported'?key:null,
      timestamp(),appId,job.attempts,key,token,Date.now()).first();
  if(!finished)throw new HTTPException(409,{message:'A sessão da fila mudou. Inicie novamente.'});
  if(outcome!=='imported'&&(await readOverrides(c.env))[appId]?.fixOverride?.file!==key)
    await c.env.MERLIN_FILES.delete(key).catch(()=>{});
  console.info('[FixImport] override finished',{appId,attempt:job.attempts,status,publishMs:Date.now()-started});
  return {success:true,status,sha256:job.sha256};
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
  const timeout=setTimeout(()=>controller.abort('timeout'),120_000);
  let checkingCancellation=false;
  const cancellationCheck=setInterval(()=>{
    if(checkingCancellation)return;
    checkingCancellation=true;
    void env.merlin_db.prepare('SELECT status,attempts FROM fix_import_jobs WHERE app_id=?').bind(job.app_id)
      .first<{status:string;attempts:number}>().then(current=>{
        if(current?.status!=='processing'||current.attempts!==job.attempts)controller.abort('job-reset');
      }).catch(()=>{}).finally(()=>{checkingCancellation=false;});
  },2000);
  let upload:R2MultipartUpload|undefined;
  const partUploads=new Set<Promise<void>>();
  try {
    await assertJob(env,token,job);
    const response=await fetchFixSource(url,{signal:controller.signal,headers:{'User-Agent':'Merlin/2.0',Accept:'application/zip,application/vnd.rar,application/octet-stream'}});
    if(!response.ok || !response.body) throw new Error(`A Ryuu respondeu com HTTP ${response.status}.`);
    const declared=Number(response.headers.get('content-length')||0);
    if(!Number.isSafeInteger(declared)||declared<0||declared>MAX_BYTES) throw new Error('Arquivo acima do limite de 2 GiB.');
    await assertJob(env,token,job);
    await env.merlin_db.prepare(`UPDATE fix_import_jobs SET processed_bytes=0,total_bytes=?,phase=?,updated_at=? WHERE app_id=? AND attempts=? AND status='processing'
      AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?)`).bind(declared,'downloading',timestamp(),job.app_id,job.attempts,token,Date.now()).run();
    const hash=createHash('sha256');
    let count=0, checked=false, header=new Uint8Array(8), headerLength=0, lastProgress=Date.now();
    const trackChunk=async(chunk:Uint8Array)=>{
      count+=chunk.byteLength;
      if(count>MAX_BYTES) throw new Error('Arquivo acima do limite de 2 GiB.');
      hash.update(chunk);
      if(!checked) {
        const copy=chunk.subarray(0,Math.min(chunk.byteLength,8-headerLength));
        header.set(copy,headerLength);headerLength+=copy.byteLength;
        if(headerLength>=8) {
          if(!validFixHeader(header,ext)) throw new Error('O conteúdo recebido não é um arquivo ZIP/RAR válido.');
          checked=true;
        }
      }
      if(Date.now()-lastProgress>4000) {
        await assertJob(env,token,job);
        const progress=await env.merlin_db.prepare(`UPDATE fix_import_jobs SET processed_bytes=?,updated_at=? WHERE app_id=? AND attempts=? AND status='processing'
          AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
          .bind(count,timestamp(),job.app_id,job.attempts,token,Date.now()).first();
        if(!progress)throw new FixImportCancelled();
        lastProgress=Date.now();
      }
    };
    const validateComplete=()=>{
      if(!checked || count<8 || (declared && declared!==count))throw new Error('O arquivo recebido está vazio ou incompleto.');
    };
    const metadata={httpMetadata:{contentType:ext==='zip'?'application/zip':'application/vnd.rar',cacheControl:'no-store'}};
    upload=await env.MERLIN_FILES.createMultipartUpload(key,metadata);
    const parts:R2UploadedPart[]=[];
    const reader=response.body.getReader();
    let buffer=new Uint8Array(PART_BYTES),used=0,nextPart=1;
    const submitPart=async(data:Uint8Array)=>{
      const partNumber=nextPart++;
      let task:Promise<void>;
      task=upload!.uploadPart(partNumber,data).then(part=>{parts[partNumber-1]=part;}).finally(()=>partUploads.delete(task));
      partUploads.add(task);
      if(partUploads.size>=PART_CONCURRENCY)await Promise.race(partUploads);
    };
    try {
      while(true) {
        const {value,done}=await reader.read();
        if(done)break;
        await trackChunk(value);
        let offset=0;
        while(offset<value.length) {
          const size=Math.min(buffer.length-used,value.length-offset);
          buffer.set(value.subarray(offset,offset+size),used);used+=size;offset+=size;
          if(used===buffer.length) {await submitPart(buffer);buffer=new Uint8Array(PART_BYTES);used=0;}
        }
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    validateComplete();
    if(used)await submitPart(buffer.subarray(0,used));
    await Promise.all(partUploads);
    await assertJob(env,token,job);
    await upload.complete(parts);
    await assertJob(env,token,job);
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
    if(partUploads.size)await Promise.allSettled([...partUploads]);
    if(upload) await upload.abort().catch(()=>{});
    if(controller.signal.aborted) {
      if(controller.signal.reason==='job-reset')throw new FixImportCancelled();
      await assertJob(env,token,job);
      throw new Error(controller.signal.reason==='timeout'?'O download demorou demais. Tente novamente.':'Não foi possível salvar o arquivo no armazenamento. Tente novamente.');
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
    WHERE id=1 AND lease_until<? AND EXISTS(SELECT 1 FROM fix_import_jobs WHERE (status='queued' AND phase='queued') OR (status='processing' AND phase NOT LIKE 'local_%')) RETURNING id`).bind(token,now+LEASE_MS,now).first();
  if(!lock)return;
  try {
    const interrupted=await env.merlin_db.prepare("UPDATE fix_import_jobs SET status='failed',phase='failed',error='O processamento foi interrompido. Tente novamente.',updated_at=? WHERE status='processing' AND phase NOT LIKE 'local_%' AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING *")
      .bind(timestamp(),token,Date.now()).all<Job>();
    if(interrupted.results.length) {
      const entries=await readOverrides(env);
      for(const job of interrupted.results)if(job.object_key && entries[job.app_id]?.fixOverride?.file===job.object_key)await setJob(env,token,job,'migrated','migrated',null,'failed');
    }
    for(let processed=0;processed<5 && Date.now()-now<45_000;processed++) {
      const candidate=await env.merlin_db.prepare("SELECT app_id,attempts FROM fix_import_jobs WHERE status='queued' AND phase='queued' ORDER BY position LIMIT 1").first<{app_id:string;attempts:number}>();
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
  app.post(`${ROOT}/local/enqueue`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const body=await c.req.json().catch(()=>null);
    const ids=selectedAppIds(body?.appIds);
    const statements=ids.map(id=>c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET status='queued',phase='local_queued',error=NULL,updated_at=?
      WHERE app_id=? AND status IN ('missing','failed') RETURNING app_id`).bind(timestamp(),id));
    let queued=0;
    for(let offset=0;offset<statements.length;offset+=50) {
      const results=await c.env.merlin_db.batch(statements.slice(offset,offset+50));
      queued+=results.reduce((sum,row)=>sum+row.results.length,0);
    }
    return c.json({success:true,queued});
  });
  app.post(`${ROOT}/local/next`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const body=await c.req.json().catch(()=>({}));
    return c.json(await claimLocalNext(c.env,typeof body?.leaseToken==='string'?body.leaseToken:''));
  });
  app.post(`${ROOT}/local/heartbeat`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const body=await c.req.json().catch(()=>null);
    const token=typeof body?.leaseToken==='string'?body.leaseToken:'';
    const updated=await c.env.merlin_db.prepare('UPDATE fix_import_control SET lease_until=? WHERE id=1 AND lease_token=? AND lease_until>? RETURNING id')
      .bind(Date.now()+LEASE_MS,token,Date.now()).first();
    if(!updated)throw new HTTPException(409,{message:'A sessão da fila local expirou. Inicie a fila novamente.'});
    return c.json({success:true});
  });
  app.post(`${ROOT}/local/progress`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const body=await c.req.json().catch(()=>null);
    const appId=String(body?.appId||'');
    if(!/^\d+$/.test(appId))throw new HTTPException(400,{message:'AppID inválido.'});
    const token=typeof body?.leaseToken==='string'?body.leaseToken:'';
    const job=await assertLocalLease(c.env,appId,token);
    if(job.phase!=='local_downloading')throw new HTTPException(409,{message:'Este jogo não está sendo baixado para o PC.'});
    const bytes=Number(body?.bytes);
    if(!Number.isSafeInteger(bytes)||bytes<0||job.total_bytes>0&&bytes>job.total_bytes)throw new HTTPException(400,{message:'Progresso inválido.'});
    await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET processed_bytes=MAX(processed_bytes,?),updated_at=? WHERE app_id=? AND status='processing' AND phase='local_downloading' AND attempts=?
      AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?)`)
      .bind(bytes,timestamp(),appId,job.attempts,token,Date.now()).run();
    return c.json({success:true});
  });
  app.get(`${ROOT}/local/:appId/source`,async c=>{
    await requireAdminSession(c);
    const appId=c.req.param('appId');
    if(!/^\d+$/.test(appId))throw new HTTPException(400,{message:'AppID inválido.'});
    return downloadLocalSource(c,appId,c.req.header('x-fix-import-lease')||'');
  });
  app.post(`${ROOT}/local/:appId/downloaded`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const appId=c.req.param('appId');
    if(!/^\d+$/.test(appId))throw new HTTPException(400,{message:'AppID inválido.'});
    const body=await c.req.json().catch(()=>null);
    return c.json(await completeLocalDownload(c,appId,String(body?.leaseToken||''),body));
  });
  app.post(`${ROOT}/local/:appId/upload/start`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const appId=c.req.param('appId');
    if(!/^\d+$/.test(appId))throw new HTTPException(400,{message:'AppID inválido.'});
    const body=await c.req.json().catch(()=>null);
    const token=String(body?.leaseToken||'');
    const job=await assertLocalLease(c.env,appId,token);
    if(!['local_upload_ready','local_uploading'].includes(job.phase)||job.total_bytes<8)
      throw new HTTPException(409,{message:'Baixe o arquivo completo antes de iniciar o envio.'});
    const partCount=Math.ceil(job.total_bytes/PART_BYTES);
    if(job.phase==='local_uploading'&&job.upload_id&&job.object_key)
      return c.json({success:true,partBytes:PART_BYTES,partCount,parts:savedParts(job)});
    const ext=extension(job.filename);
    if(!ext)throw new HTTPException(400,{message:'O arquivo precisa ser ZIP ou RAR.'});
    const key=`${appId}/fixes/${c.env.ENVIRONMENT==='staging'?'_staging/':''}ryuu-import-${crypto.randomUUID()}.${ext}`;
    let upload:R2MultipartUpload;
    try {
      upload=await c.env.MERLIN_FILES.createMultipartUpload(key,{httpMetadata:{contentType:ext==='zip'?'application/zip':'application/vnd.rar',cacheControl:'no-store'}});
    } catch {
      throw new HTTPException(502,{message:'Não foi possível iniciar o envio ao R2.'});
    }
    const changed=await c.env.merlin_db.prepare(`UPDATE fix_import_jobs SET phase='local_uploading',processed_bytes=0,object_key=?,upload_id=?,upload_parts=NULL,updated_at=?
      WHERE app_id=? AND status='processing' AND phase='local_upload_ready' AND attempts=? AND EXISTS(SELECT 1 FROM fix_import_control WHERE id=1 AND lease_token=? AND lease_until>?) RETURNING app_id`)
      .bind(key,upload.uploadId,timestamp(),appId,job.attempts,token,Date.now()).first();
    if(!changed) {
      await upload.abort().catch(()=>{});
      throw new HTTPException(409,{message:'A sessão da fila local expirou. Inicie a fila novamente.'});
    }
    return c.json({success:true,partBytes:PART_BYTES,partCount,parts:[]});
  });
  app.post(`${ROOT}/local/:appId/upload/part`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const appId=c.req.param('appId');
    if(!/^\d+$/.test(appId))throw new HTTPException(400,{message:'AppID inválido.'});
    const token=c.req.header('x-fix-import-lease')||'';
    const partNumber=Number(c.req.header('x-fix-import-part-number'));
    return c.json(await uploadLocalPart(c,appId,token,partNumber));
  });
  app.post(`${ROOT}/local/:appId/upload/complete`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const appId=c.req.param('appId');
    if(!/^\d+$/.test(appId))throw new HTTPException(400,{message:'AppID inválido.'});
    const body=await c.req.json().catch(()=>null);
    return c.json(await completeLocalUpload(c,appId,String(body?.leaseToken||'')));
  });
  app.post(`${ROOT}/local/fail`,async c=>{
    await requireAdminSession(c,{mutate:true});
    const body=await c.req.json().catch(()=>null);
    const appId=String(body?.appId||'');
    if(!/^\d+$/.test(appId))throw new HTTPException(400,{message:'AppID inválido.'});
    return c.json(await failLocalJob(c.env,appId,String(body?.leaseToken||'')));
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
