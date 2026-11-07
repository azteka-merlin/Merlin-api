import {describe,expect,test,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import type {AppBindings} from '../src/types';
const {processQueue}=vi.hoisted(()=>({processQueue:vi.fn(async(_env:AppBindings)=>{})}));
vi.mock('../src/lib/fix-import',async importOriginal=>({
  ...await importOriginal<typeof import('../src/lib/fix-import')>(),processFixImportQueue:processQueue,
}));
import worker from '../src/index';

describe('staging fix import scheduling',()=>{
  test('the deployed staging configuration has an automatic scheduler',()=>{
    const config=ts.parseConfigFileTextToJson('wrangler.jsonc',readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
    expect(config.error).toBeUndefined();
    expect(config.config.env.staging.triggers.crons).toContain('* * * * *');
  });

  test('the real staging handler processes imports without accessing billing, notifications or other scheduled services',async()=>{
    const env=new Proxy({ENVIRONMENT:'staging'}, {get(target,key){
      if(key==='ENVIRONMENT')return target.ENVIRONMENT;
      throw new Error(`An unrelated staging service accessed ${String(key)}`);
    }}) as AppBindings;
    const pending:Promise<unknown>[]=[];
    await worker.scheduled({scheduledTime:Date.UTC(2026,10,7,12,0)} as ScheduledController,env,{waitUntil(task:Promise<unknown>){pending.push(task);}} as ExecutionContext);
    await Promise.all(pending);
    expect(processQueue.mock.calls).toHaveLength(1);
    expect(processQueue.mock.calls[0]?.[0]).toBe(env);
    expect(pending).toHaveLength(1);
  });
});
