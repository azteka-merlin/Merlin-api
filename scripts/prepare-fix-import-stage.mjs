#!/usr/bin/env node
// Run the same discovery code as the admin against staging, using Wrangler's
// current credentials. This command never enqueues or downloads fix archives.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory=mkdtempSync(join(tmpdir(),'merlin-fix-discovery-'));
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js');
const compiled=join(directory,'fix-import.mjs');
await build({entryPoints:['src/lib/fix-import.ts'],bundle:true,platform:'node',format:'esm',outfile:compiled,
  banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require=__createRequire(import.meta.url);"}});
const { enqueueFixImports, getFixImportDashboard }=await import(pathToFileURL(compiled).href);
let sequence=0;
function quote(value){if(value===null||value===undefined)return 'NULL';if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Invalid number');return String(value);}return `'${String(value).replaceAll("'","''")}'`;}
function sql(source,values){let index=0;const result=source.replace(/\?/g,()=>quote(values[index++]));if(index!==values.length)throw Error('SQL binding mismatch');return result;}
function execute(statements){
  const file=join(directory,`query-${sequence++}.sql`);writeFileSync(file,statements.join(';\n')+';');
  const source=statements.join(';\n');
  const input=source.length<2000?['--command',source]:['--file',file];
  const output=execFileSync(process.execPath,[wrangler,'d1','execute','merlin-db-stage','--env','staging','--remote','--json',...input],{encoding:'utf8',maxBuffer:8*1024**2});
  // Wrangler may print upload progress before its JSON when using --file.
  const start=output.search(/^\s*\[\s*$/m);
  if(start<0)throw Error('Wrangler did not return a D1 result.');
  return JSON.parse(output.slice(start));
}
function statement(source,values=[]){
  return {sql:()=>sql(source,values),bind:(...next)=>statement(source,next),
    first:async()=>execute([sql(source,values)])[0]?.results?.[0]||null,
    all:async()=>execute([sql(source,values)])[0],run:async()=>execute([sql(source,values)])[0]};
}
const env={ENVIRONMENT:'staging',merlin_db:{prepare:statement,batch:async statements=>execute(statements.map(item=>item.sql()))},
  MERLIN_FILES:{get:async key=>{
    if(!['overrides.json','_fix-import/staging/overrides.json'].includes(key))throw Error('Unexpected object read');
    const file=join(directory,`object-${sequence++}.json`);
    try{execFileSync(process.execPath,[wrangler,'r2','object','get',`merlin-files/${key}`,'--remote','--file',file],{encoding:'utf8',stdio:'pipe'});}
    catch(error){if(/does not exist|not found|NoSuchKey|404/i.test(String(error.stderr||'')+String(error.stdout||'')))return null;throw error;}
    const content=readFileSync(file,'utf8');return {text:async()=>content};
  }}};
const before=await env.merlin_db.prepare('SELECT COUNT(*) AS total FROM fix_import_jobs').first();
const result=await enqueueFixImports({env});
const after=await env.merlin_db.prepare('SELECT COUNT(*) AS total FROM fix_import_jobs').first();
const dashboard=await getFixImportDashboard(env);
console.log(JSON.stringify({discovered:Number(after.total)-Number(before.total),ignored:result.ignored,summary:dashboard.summary,
  first:dashboard.jobs.slice(0,5).map(job=>({appId:job.app_id,name:job.name,position:job.position,status:job.status}))},null,2));
