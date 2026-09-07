const PDF_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

export async function assertPdfStorageObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  filePath: string,
  expectedSizeBytes: number,
) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/thesis-pdfs/${encodeStoragePath(filePath)}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Range: "bytes=0-4",
      },
    },
  );

  if (!response.ok) {
    throw new Error("Uploaded PDF could not be read from private storage");
  }

  const header = await readHeader(response, PDF_SIGNATURE.length);
  if (!matchesSignature(header, PDF_SIGNATURE)) {
    throw new Error("Uploaded file is not a valid PDF");
  }

  const contentRange = response.headers.get("content-range");
  const totalSize = contentRange ? Number(contentRange.split("/").pop()) : NaN;
  if (Number.isFinite(totalSize) && totalSize !== expectedSizeBytes) {
    throw new Error("Uploaded PDF size does not match its stored object");
  }
}

async function readHeader(response: Response, length: number) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < length) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      size += result.value.byteLength;
    }
  } finally {
    await reader.cancel();
  }

  const header = new Uint8Array(Math.min(size, length));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = header.length - offset;
    if (remaining <= 0) break;
    const slice = chunk.subarray(0, remaining);
    header.set(slice, offset);
    offset += slice.length;
  }
  return header;
}

function matchesSignature(value: Uint8Array, signature: Uint8Array) {
  return value.length >= signature.length && signature.every((byte, index) => value[index] === byte);
}

function encodeStoragePath(filePath: string) {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
