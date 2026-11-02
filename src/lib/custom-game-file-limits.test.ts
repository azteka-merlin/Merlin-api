import { expect, it } from 'vitest';
import type { AppContext } from '../types';
import { validateGameFilePath, validateSha256 } from './custom-games';
import { validateIntegrityManifest, storeManifest, type IntegrityGame } from './custom-game-integrity';
import { folderManifestObjectKeys } from './custom-game-package-lifecycle';

it('accepts and stores the integrity manifest for 200,000 folder files, and rejects 200,001',async()=>{
  const game:IntegrityGame={id:'00000000-0000-4000-8000-000000000001',name:'Large folder',
    archive_key:'manifests/00000000-0000-4000-8000-000000000002.json',archive_size:200000,package_type:'folder'};
  const files=Array.from({length:200000},(_,i)=>({path:`data/${i}.bin`,sizeBytes:1,sha256:'a'.repeat(64)}));
  const input={version:1,gameId:game.id,archiveKey:game.archive_key,totalSizeBytes:files.length,files};
  const manifest=validateIntegrityManifest(input,game,{validateGameFilePath,validateSha256});
  expect(manifest.files).toHaveLength(200000);
  let storedBytes=0;
  const c={env:{CUSTOM_GAMES:{async put(_key:string,value:string){storedBytes=new TextEncoder().encode(value).byteLength;}}}} as unknown as AppContext;
  await storeManifest(c,manifest);
  expect(storedBytes).toBeGreaterThan(16*1024*1024);
  expect(storedBytes).toBeLessThanOrEqual(32*1024*1024);
  files.push({path:'extra.bin',sizeBytes:1,sha256:'a'.repeat(64)});
  expect(()=>validateIntegrityManifest({...input,totalSizeBytes:files.length},game,{validateGameFilePath,validateSha256})).toThrow();
},20000);

it('keeps large folder references available for cleanup without accepting more than 200,000 files',()=>{
  const key='game-files/00000000-0000-4000-8000-000000000002';
  const files=Array.from({length:200000},(_,i)=>({key,path:`${i}.bin`,sizeBytes:1}));
  expect(folderManifestObjectKeys({files})).toEqual([key]);
  files.push({key,path:'extra.bin',sizeBytes:1});
  expect(()=>folderManifestObjectKeys({files})).toThrow();
});
