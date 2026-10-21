import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 80;

/** Small, dependency-free ZIP writer for the generated static project. */
export async function projectZip(root: string): Promise<Buffer> {
  const files: Array<{ name: string; bytes: Buffer }> = [];
  let total = 0;
  async function visit(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === '.DS_Store' || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Project contains an unsupported symlink');
      if (info.isDirectory()) { await visit(path, name); continue; }
      if (!info.isFile()) continue;
      if (++total > MAX_FILES) throw new Error('Project contains too many files');
      const bytes = await readFile(path);
      const sum = files.reduce((value, file) => value + file.bytes.length, 0) + bytes.length;
      if (sum > MAX_ARCHIVE_BYTES) throw new Error('Project download is too large');
      files.push({ name, bytes });
    }
  }
  await visit(root, '');
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.bytes.length, 18);
    header.writeUInt32LE(file.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, file.bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(file.bytes.length, 20);
    record.writeUInt32LE(file.bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
