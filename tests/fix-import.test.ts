import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { enqueueFixImports, getFixImportDashboard, processFixImportQueue, registerFixImportRoutes, validFixHeader, validRyuuFixUrl } from '../src/lib/fix-import';
import { getFixOverrideFile, readOverrides, upsertOverride } from '../src/lib/overrides';
import type { AppBindings, AppContext } from '../src/types';
import { requireAdminSession } from '../src/lib/admin-security';
import { FixesCatalogRoute } from '../src/endpoints/fixes-catalog';

vi.mock('../src/lib/admin-security',()=>({requireAdminSession:vi.fn(async()=>({}))}));
let runtime:Miniflare;
let env:AppBindings;
let app:Hono<{Bindings:AppBindings}>;
const zip=()=>new Uint8Array([80,75,5,6,...new Array(18).fill(0)]);
const fix=(id:string,badges:string[]=[])=>({appid:id,name:`Jogo ${id}`,fixes:[{href:`https://generator.ryuu.lol/fixes/${id}.zip`,filename:`${id}.zip`,badges}]});
const catalog=()=>[fix('10'),fix('20'),fix('30'),fix('40',['ONLINE']),fix('50',['hypervisor']),fix('60'),
  {appid:'70',name:'Fora da Ryuu',fixes:[{href:'https://example.test/file.zip',filename:'70.zip'}]},fix('80')];
function context(){return {env} as AppContext;}
async function scan(){return enqueueFixImports(context());}
async function enqueue(ids:string[]){return app.request('/panel-api/fix-import/enqueue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appIds:ids})},env);}

beforeEach(async()=>{
  vi.clearAllMocks();
  runtime=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local");}}',
    compatibilityDate:'2026-06-20',d1Databases:['DB'],r2Buckets:['FILES']});
  const db=await runtime.getD1Database('DB');
  const sql=readFileSync(new URL('../migrations/0096_fix_import_queue.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  await db.prepare('CREATE TABLE catalog_game_metadata(app_id TEXT PRIMARY KEY,release_date TEXT,denuvo INTEGER,drm_notice TEXT)').run();
  await db.prepare('CREATE TABLE correction_votes(app_id TEXT,vote TEXT)').run();
  await db.prepare("INSERT INTO catalog_game_metadata VALUES('20','2026-10-01',1,NULL)").run();
  await db.prepare("INSERT INTO correction_votes VALUES('10','up')").run();
  const bucket=await runtime.getR2Bucket('FILES');
  env={merlin_db:db,MERLIN_FILES:bucket,ENVIRONMENT:'production',RYUU_AUTH_CODE:'local-secret'} as unknown as AppBindings;
  await bucket.put('overrides.json',JSON.stringify({
    '30':{name:'Oculto',hidden:true},
    '60':{name:'Fix próprio',fixOverride:{enabled:true,file:'60/fixes/manual.zip'}},
    '80':{name:'Manifest próprio',manifestOverride:{enabled:true,file:'80/manifests/manual.zip'}},
  }));
  vi.stubGlobal('fetch',vi.fn(async(_input,init)=>{expect(init?.redirect).toBe('manual');return Response.json(catalog());}));
  app=new Hono<{Bindings:AppBindings}>();registerFixImportRoutes(app);
});
afterEach(async()=>{vi.unstubAllGlobals();await runtime?.dispose();});

describe('fix import workflow with native D1 and R2',()=>{
  test.each(['network','timeout','http','json','schema'])('catalog %s failure returns a useful upstream error, preserves jobs and releases the scan reservation',async failure=>{
    await scan();
    const before=await getFixImportDashboard(env);
    vi.stubGlobal('fetch',vi.fn(async()=>{
      if(failure==='network')throw new TypeError('fetch failed');
      if(failure==='timeout')throw new DOMException('Request timed out','TimeoutError');
      if(failure==='http')return new Response('unavailable',{status:503});
      if(failure==='schema')return Response.json({error:'unavailable'});
      return new Response('<html>unavailable</html>',{headers:{'Content-Type':'application/json'}});
    }));
    const response=await app.request('/panel-api/fix-import/scan',{method:'POST'},env);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Ryuu');
    expect((await getFixImportDashboard(env)).jobs).toEqual(before.jobs);
    expect(await env.merlin_db.prepare('SELECT scan_token,scan_until FROM fix_import_control WHERE id=1').first()).toMatchObject({scan_token:null,scan_until:0});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json(catalog())));
    expect((await app.request('/panel-api/fix-import/scan',{method:'POST'},env)).status).toBe(200);
  });

  test('discovery preserves screen order, excludes manual fixes and hidden games, but includes manifest-only overrides',async()=>{
    expect((await scan()).discovered).toBe(3);
    const dashboard=await getFixImportDashboard(env);
    expect(dashboard.jobs.map(j=>j.app_id)).toEqual(['20','10','80']);
    expect(dashboard.jobs.every(j=>j.status==='missing')).toBe(true);
    expect(dashboard.summary.missing).toBe(3);
    await processFixImportQueue(env);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect((await scan()).discovered).toBe(0);
    expect((await getFixImportDashboard(env)).jobs.map(j=>j.position)).toEqual([1,2,3]);
  });

  test('selected jobs download in saved order, become migrated overrides and saving marks them reviewed',async()=>{
    await scan();expect((await enqueue(['10','20'])).status).toBe(200);
    const downloads:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      expect(init?.redirect).toBe('manual');
      const url=new URL(String(input));downloads.push(url.pathname);
      expect(url.hostname).toBe('generator.ryuu.lol');expect(url.searchParams.get('auth_code')).toBe('local-secret');
      return new Response(zip(),{headers:{'Content-Length':'22'}});
    }));
    await Promise.all([processFixImportQueue(env),processFixImportQueue(env)]);
    expect(downloads).toEqual(['/fixes/20.zip','/fixes/10.zip']);
    const entries=await readOverrides(env);
    expect(entries['20']?.migrated).toBe(true);expect(entries['10']?.fixOverride?.enabled).toBe(true);
    expect(entries['60']?.fixOverride?.file).toBe('60/fixes/manual.zip');
    expect((await getFixImportDashboard(env)).summary.migrated).toBe(2);
    await upsertOverride(env,'20',entries['20']!);
    expect((await readOverrides(env))['20']?.migrated).toBeUndefined();
    expect((await getFixImportDashboard(env)).summary.migrated).toBe(2);
    expect((await enqueue(['20'])).status).toBe(200);
    expect((await getFixImportDashboard(env)).summary.queued).toBe(0);
  });

  test('invalid and truncated downloads fail without publishing; a manual retry succeeds',async()=>{
    await scan();await enqueue(['20']);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>error</html>')));
    await processFixImportQueue(env);
    expect((await getFixImportDashboard(env)).summary.failed).toBe(1);
    expect((await readOverrides(env))['20']).toBeUndefined();
    await enqueue(['20']);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(zip(),{headers:{'Content-Length':'500'}})));
    await processFixImportQueue(env);
    expect((await readOverrides(env))['20']).toBeUndefined();
    await enqueue(['20']);vi.stubGlobal('fetch',vi.fn(async()=>new Response(zip())));
    await processFixImportQueue(env);
    expect((await getFixImportDashboard(env)).summary.migrated).toBe(1);
  });

  test('a redirected catalog preserves the list and a redirected download never publishes an override',async()=>{
    await scan();
    const before=(await getFixImportDashboard(env)).jobs;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:302,headers:{Location:'https://other.test/fixes.json'}})));
    expect((await app.request('/panel-api/fix-import/scan',{method:'POST'},env)).status).toBe(502);
    expect((await getFixImportDashboard(env)).jobs).toEqual(before);
    await enqueue(['20']);
    await processFixImportQueue(env);
    expect((await getFixImportDashboard(env)).jobs.find(job=>job.app_id==='20')).toMatchObject({status:'failed',object_key:null});
    expect((await readOverrides(env))['20']).toBeUndefined();
    expect((await env.MERLIN_FILES.list({prefix:'20/fixes/'})).objects).toHaveLength(0);
  });

  test('interrupted finalization recognizes an already registered file without redownloading or restoring the review badge',async()=>{
    await scan();await enqueue(['20']);vi.stubGlobal('fetch',vi.fn(async()=>new Response(zip())));
    await processFixImportQueue(env);
    await upsertOverride(env,'20',(await readOverrides(env))['20']!);
    await env.merlin_db.prepare("UPDATE fix_import_jobs SET status='processing',phase='publishing' WHERE app_id='20'").run();
    await processFixImportQueue(env);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect((await readOverrides(env))['20']?.migrated).toBeUndefined();
    expect((await getFixImportDashboard(env)).summary.migrated).toBe(1);
  });

  test('an override created or hidden during the download wins and disappears from the import list',async()=>{
    await scan();await enqueue(['20']);
    vi.stubGlobal('fetch',vi.fn(async()=>{
      await upsertOverride(env,'20',{name:'Ocultado durante download',hidden:true});return new Response(zip());
    }));
    await processFixImportQueue(env);
    expect((await readOverrides(env))['20']).toMatchObject({hidden:true});
    expect((await readOverrides(env))['20']?.fixOverride).toBeUndefined();
    expect((await getFixImportDashboard(env)).jobs.some(j=>j.app_id==='20')).toBe(false);
  });

  test('a manifest-only game receives its fix while preserving manifest changes made during the download',async()=>{
    await scan();await enqueue(['80']);
    vi.stubGlobal('fetch',vi.fn(async()=>{
      await upsertOverride(env,'80',{name:'Nome revisado',adminNote:'Preservar esta nota',manifestOverride:{enabled:true,file:'80/manifests/new.zip'}});
      return new Response(zip());
    }));
    await processFixImportQueue(env);
    expect((await readOverrides(env))['80']).toMatchObject({name:'Nome revisado',adminNote:'Preservar esta nota',migrated:true,
      manifestOverride:{enabled:true,file:'80/manifests/new.zip'},fixOverride:{enabled:true}});
    expect((await getFixImportDashboard(env)).summary.migrated).toBe(1);
  });

  test('staging files, migrated badges and review saves stay isolated from production',async()=>{
    const primary=await env.MERLIN_FILES.get('overrides.json');const before=await primary!.text();
    env={...env,ENVIRONMENT:'staging'} as AppBindings;
    await scan();await enqueue(['20','80']);vi.stubGlobal('fetch',vi.fn(async()=>new Response(zip())));
    await processFixImportQueue(env);
    const stage=await readOverrides(env);expect(stage['20']?.migrated).toBe(true);
    expect(stage['20']?.fixOverride?.file).toContain('/fixes/_staging/');
    const file=await getFixOverrideFile(env,'20');expect(file?.object.size).toBe(22);
    expect(stage['80']).toMatchObject({migrated:true,manifestOverride:{enabled:true,file:'80/manifests/manual.zip'},fixOverride:{enabled:true}});
    await upsertOverride(env,'20',stage['20']!);
    expect((await readOverrides(env))['20']?.migrated).toBeUndefined();
    await upsertOverride(env,'80',stage['80']!);
    expect((await readOverrides(env))['80']?.migrated).toBeUndefined();
    expect(await (await env.MERLIN_FILES.get('overrides.json'))!.text()).toBe(before);
    expect((await readOverrides({...env,ENVIRONMENT:'production'}))['20']).toBeUndefined();
  });

  test('the Corrections catalog still serves local overrides when Ryuu is unavailable',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('Ryuu offline');}));
    app.get('/api/fixes/catalog',c=>new FixesCatalogRoute().handle(c));
    const response=await app.request('/api/fixes/catalog',{},env);
    expect(response.status).toBe(200);
    const items=await response.json() as {appid:string;fixes:{href:string}[]}[];
    expect(items.map(item=>item.appid)).toEqual(['60']);
    expect(items[0]?.fixes[0]?.href).toContain('/api/fixes/download?appid=60');
  });

  test('reviewing an imported staging entry never overwrites a production fix added later',async()=>{
    env={...env,ENVIRONMENT:'staging'} as AppBindings;
    await scan();await enqueue(['20']);vi.stubGlobal('fetch',vi.fn(async()=>new Response(zip())));
    await processFixImportQueue(env);
    const imported=(await readOverrides(env))['20']!;
    await upsertOverride({...env,ENVIRONMENT:'production'},'20',{name:'Novo fix manual',fixOverride:{enabled:true,file:'20/fixes/manual.zip'}});
    const before=await (await env.MERLIN_FILES.get('overrides.json'))!.text();
    await upsertOverride(env,'20',imported);
    expect(await (await env.MERLIN_FILES.get('overrides.json'))!.text()).toBe(before);
    expect((await readOverrides(env))['20']?.fixOverride?.file).toBe('20/fixes/manual.zip');
  });

  test('an expired worker cannot overwrite the new owner status after a delayed download fails',async()=>{
    await scan();await enqueue(['20']);
    vi.stubGlobal('fetch',vi.fn(async()=>{
      await env.merlin_db.prepare('UPDATE fix_import_control SET lease_token=?,lease_until=? WHERE id=1').bind('new-worker',Date.now()+600000).run();
      await env.merlin_db.prepare("UPDATE fix_import_jobs SET status='processing',phase='publishing',error=NULL WHERE app_id='20'").run();
      throw new Error('Old download failed');
    }));
    await expect(processFixImportQueue(env)).rejects.toThrow('perdeu a reserva');
    const job=(await getFixImportDashboard(env)).jobs.find(job=>job.app_id==='20');
    expect(job).toMatchObject({status:'processing',phase:'publishing',error:null});
  });

  test('only admin sessions can discover or enqueue; malformed and oversized selections are rejected',async()=>{
    vi.mocked(requireAdminSession).mockRejectedValueOnce(new HTTPException(401,{message:'Unauthorized'}));
    expect((await app.request('/panel-api/fix-import',{},env)).status).toBe(401);
    expect((await enqueue(['../../bad'])).status).toBe(400);
    expect((await enqueue(Array.from({length:201},(_,i)=>String(i+1)))).status).toBe(400);
    for(const body of ['null','{','[]'])expect((await app.request('/panel-api/fix-import/enqueue',{method:'POST',headers:{'Content-Type':'application/json'},body},env)).status).toBe(400);
    expect((await app.request('/panel-api/fix-import/pause',{method:'POST'},env)).status).toBe(404);
  });

  test('archive origin and signatures reject arbitrary hosts, redirects encoded as credentials and HTML',()=>{
    for(const url of ['http://generator.ryuu.lol/fixes/x.zip','https://127.0.0.1/fixes/x.zip','https://generator.ryuu.lol@evil.test/fixes/x.zip','https://generator.ryuu.lol/fixes/x.zip?auth_code=secret'])expect(validRyuuFixUrl(url)).toBe(false);
    expect(validFixHeader(new TextEncoder().encode('<html>failed</html>'),'zip')).toBe(false);
    expect(validFixHeader(new Uint8Array([80,75,3,6,0,0,0,0]),'zip')).toBe(false);
    expect(validFixHeader(new Uint8Array([82,97,114,33,26,7,0,207]),'rar')).toBe(true);
    expect(validFixHeader(new Uint8Array([82,97,114,33,26,7,1,0]),'rar')).toBe(true);
  });
});
