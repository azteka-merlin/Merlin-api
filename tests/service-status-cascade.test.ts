import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSources, fetchSource } from '../src/endpoints/manifests';

// O mock substitui globalmente fetch antes de cada teste: nenhuma chamada externa.
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const makeSources = () => createSources('12345', {
  HBCP_KEY: 'synthetic', RYU_API_URL: 'https://synthetic.invalid/manifest', RYUU_AUTH_CODE: 'synthetic',
}, 'hubcap');
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(() => { throw new Error('UNEXPECTED_FETCH_BLOCKED'); }); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('contratos reais de fetchSource, com fetch substituído', () => {
  test('404 do jogo produz missing; 503 produz unavailable', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {status:404})).mockResolvedValueOnce(new Response(null, {status:503}));
    const [source] = makeSources();
    expect((await fetchSource(source!, '12345')).outcome).toMatchObject({result:'missing',kind:'http',status:404});
    expect((await fetchSource(source!, '12345')).outcome).toMatchObject({result:'unavailable',kind:'http',status:503});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test('200 sem ZIP é inválido, não sucesso', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not a zip', {status:200}));
    const result=await fetchSource(makeSources()[0]!, '12345');
    expect(result.response).toBeNull(); expect(result.outcome).toMatchObject({result:'unavailable',kind:'invalid_zip'});
  });
  test('ZIP retorna response e outcome missing artificial; response prevalece', async () => {
    fetchMock.mockResolvedValueOnce(new Response(zip));
    const result=await fetchSource(makeSources()[0]!, '12345');
    expect(result.response).not.toBeNull(); expect(result.outcome.result).toBe('missing');
    expect(new Uint8Array(await result.response!.arrayBuffer())).toEqual(zip);
  });
  test('Hubcap falha e Ryuu retorna ZIP sem requisição além do fallback', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(new Response(zip));
    const sources=makeSources(); const first=await fetchSource(sources[0]!, '12345');
    const second=await fetchSource(sources[1]!, '12345');
    expect(first.response).toBeNull(); expect(second.response).not.toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test('Hubcap atende, portanto a cascata simulada não consulta outra fonte', async () => {
    fetchMock.mockResolvedValueOnce(new Response(zip));
    const sources=makeSources();
    for (const source of sources) { if ((await fetchSource(source,'12345')).response) break; }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test('duas fontes falham e fallback seguinte atende', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(new Response(zip));
    const sources=makeSources(); let selected='';
    for (const source of sources) { if ((await fetchSource(source,'12345')).response) { selected=source.name; break; } }
    expect(selected).toBe('skyflare'); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  test('403 de fornecedor é unavailable, mas causa sistêmica não é comprovada', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null,{status:403}));
    const result=await fetchSource(makeSources()[0]!, '12345');
    expect(result.outcome).toMatchObject({result:'unavailable',kind:'http',status:403});
  });
  test('timeout operacional retorna timeout sem rede', async () => {
    fetchMock.mockImplementationOnce((_url:unknown, init:RequestInit) => new Promise((_resolve,reject) => {
      init.signal!.addEventListener('abort',()=>reject(new Error('mock abort')),{once:true});
    }));
    const source={...makeSources()[0]!,timeoutMs:5};
    expect((await fetchSource(source,'12345')).outcome).toMatchObject({result:'unavailable',kind:'timeout'});
  });
  test('stream pode falhar depois de aceita a assinatura ZIP', async () => {
    let reads=0;
    const stream=new ReadableStream({pull(controller){ if(reads++===0)controller.enqueue(zip); else controller.error(new Error('synthetic stream failure')); }});
    fetchMock.mockResolvedValueOnce(new Response(stream));
    const result=await fetchSource(makeSources()[0]!, '12345');
    expect(result.response).not.toBeNull();
    await expect(result.response!.arrayBuffer()).rejects.toThrow('synthetic stream failure');
  });
});
