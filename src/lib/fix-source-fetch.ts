// Workerd supports "manual" and "follow", but rejects redirect: "error".
// Inspect redirects ourselves so an authenticated fix URL is never followed.
export async function fetchFixSource(input: string | URL, init: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('A Ryuu retornou um redirecionamento. A importação não seguiu o novo endereço.');
  }
  return response;
}
