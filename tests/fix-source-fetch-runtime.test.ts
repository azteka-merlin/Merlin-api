import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest';
import {Miniflare,Response as EdgeResponse} from 'miniflare';
import {build} from 'esbuild';
import {resolve} from 'node:path';

let runtime:Miniflare;
let requests:string[]=[];
beforeAll(async()=>{
  const bundle=await build({bundle:true,write:false,format:'esm',platform:'browser',stdin:{
    resolveDir:resolve('src/lib'),loader:'ts',contents:`
      import {fetchFixSource} from './fix-source-fetch';
      import {putKnownLengthR2Stream} from './r2-stream-upload';
      export default {async fetch(request,env) {
        if(new URL(request.url).pathname==='/stream') {
          const bytes=new Uint8Array([80,75,5,6,...new Array(18).fill(0)]);
          const body=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}});
          await putKnownLengthR2Stream(env.FILES,'test/known-length.zip',body,bytes.length,{httpMetadata:{contentType:'application/zip'}});
          const object=await env.FILES.get('test/known-length.zip');
          return Response.json({size:object.size,bytes:[...new Uint8Array(await object.arrayBuffer())]});
        }
        const status=new URL(request.url).pathname.slice(1);
        try {
          const response=await fetchFixSource('https://generator.ryuu.lol/fixes/'+status+'.zip?auth_code=local-secret',{});
          return new Response(await response.arrayBuffer(),{status:response.status});
        } catch(error) {return new Response(error.message,{status:502});}
      }};`,
  }});
  runtime=new Miniflare({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-06-20',r2Buckets:['FILES'],
    outboundService:request=>{
      const url=new URL(request.url);requests.push(request.url);
      if(url.hostname!=='generator.ryuu.lol')return new EdgeResponse('Redirect must not be followed',{status:500});
      const status=Number(url.pathname.split('/').at(-1)?.replace('.zip',''));
      return status===200?new EdgeResponse('archive',{status:200}):
        new EdgeResponse('redirect',{status,headers:{Location:'https://other.test/file.zip'}});
    },
  });
});
beforeEach(()=>{requests=[];});
afterAll(async()=>{await runtime?.dispose();});

describe('fix source fetch in native workerd, without mocking Worker fetch',()=>{
  test('streams a known-length archive directly into R2 in the Worker runtime',async()=>{
    const response=await runtime.dispatchFetch('https://local.test/stream');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({size:22,bytes:[80,75,5,6,...new Array(18).fill(0)]});
  });

  test('accepts a successful response using the actual shared fetch policy',async()=>{
    const response=await runtime.dispatchFetch('https://local.test/200');
    expect(response.status).toBe(200);expect(await response.text()).toBe('archive');
    expect(requests).toHaveLength(1);
  });

  test.each([301,302,303,307,308])('rejects HTTP %s without contacting the destination or forwarding authentication',async status=>{
    const response=await runtime.dispatchFetch(`https://local.test/${status}`);
    expect(response.status).toBe(502);expect(await response.text()).toContain('redirecionamento');
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!).hostname).toBe('generator.ryuu.lol');
  });
});
