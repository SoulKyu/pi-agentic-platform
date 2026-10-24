/** R33 (RT-15): `file_put` is chunked like the transcript. A leaf file: `agents-vm.ts` and `boxes.ts` both need it and import each other's schemas. */
export const FILE_CHUNK_BYTES = 2 * 1024 * 1024;
export const FILE_CHUNK_B64 = Math.ceil(FILE_CHUNK_BYTES / 3) * 4;
