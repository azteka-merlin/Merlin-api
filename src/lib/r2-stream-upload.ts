export async function putKnownLengthR2Stream(
  bucket:R2Bucket,
  key:string,
  body:ReadableStream<Uint8Array>,
  length:number,
  options:R2PutOptions,
  signal?:AbortSignal,
) {
  const fixed=new FixedLengthStream(length);
  const stored=bucket.put(key,fixed.readable,options);
  const piped=signal ? body.pipeTo(fixed.writable,{signal}) : body.pipeTo(fixed.writable);
  const [object]=await Promise.all([stored,piped]);
  return object;
}
