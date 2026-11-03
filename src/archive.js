import { gunzipSync, inflateRawSync } from 'node:zlib';

const LIMIT = 32 * 1024 * 1024;
function validMember(name) {
  return typeof name === 'string' && !name.startsWith('/') && !name.includes('\\') && name.split('/').every(p=>p!== '..' && p!=='.');
}
export function extractBinary(archive, member, format) {
  if (!validMember(member)) throw new Error('Invalid kernel archive member.');
  if (format === 'tar.gz') {
    const tar=gunzipSync(archive,{maxOutputLength:128*1024*1024});
    for(let offset=0;offset+512<=tar.length;) {
      const header=tar.subarray(offset,offset+512);
      if(header.every(b=>b===0))break;
      const text=(from,to)=>header.subarray(from,to).toString('utf8').replace(/\0.*$/s,'');
      const name=[text(345,500),text(0,100)].filter(Boolean).join('/');
      const size=parseInt(text(124,136).trim(),8);
      const checksum=parseInt(text(148,156).trim(),8);
      let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:header[i];
      if(!Number.isSafeInteger(size)||size<0||checksum!==actual||offset+512+size>tar.length)throw new Error('Invalid tar archive.');
      if(name===member) {
        if(![0,48].includes(header[156])||size>LIMIT)throw new Error('Kernel member is not a bounded regular file.');
        return tar.subarray(offset+512,offset+512+size);
      }
      offset+=512+Math.ceil(size/512)*512;
    }
  } else if(format==='zip') {
    let end=-1;
    for(let i=archive.length-22;i>=Math.max(0,archive.length-65557);i--)if(archive.readUInt32LE(i)===0x06054b50){end=i;break;}
    if(end<0||archive.readUInt16LE(end+4)!==0||archive.readUInt16LE(end+6)!==0)throw new Error('Unsupported zip archive.');
    const count=archive.readUInt16LE(end+10);let cursor=archive.readUInt32LE(end+16);
    for(let i=0;i<count;i++) {
      if(cursor+46>archive.length||archive.readUInt32LE(cursor)!==0x02014b50)throw new Error('Invalid zip directory.');
      const length=archive.readUInt16LE(cursor+28),extra=archive.readUInt16LE(cursor+30),comment=archive.readUInt16LE(cursor+32);
      const name=archive.subarray(cursor+46,cursor+46+length).toString('utf8');
      if(name===member) {
        const flags=archive.readUInt16LE(cursor+8),method=archive.readUInt16LE(cursor+10),compressed=archive.readUInt32LE(cursor+20),size=archive.readUInt32LE(cursor+24),local=archive.readUInt32LE(cursor+42);
        if(flags&1||size>LIMIT||local+30>archive.length||archive.readUInt32LE(local)!==0x04034b50)throw new Error('Unsupported kernel zip member.');
        const nl=archive.readUInt16LE(local+26),el=archive.readUInt16LE(local+28),start=local+30+nl+el;
        if(archive.subarray(local+30,local+30+nl).toString('utf8')!==member||start+compressed>archive.length)throw new Error('Invalid zip member.');
        const bytes=archive.subarray(start,start+compressed);
        const output=method===0?bytes:method===8?inflateRawSync(bytes,{maxOutputLength:LIMIT}):null;
        if(!output||output.length!==size)throw new Error('Invalid kernel zip size or method.');
        return output;
      }
      cursor+=46+length+extra+comment;
    }
  } else if(format==='raw') return archive;
  else throw new Error('Unsupported kernel archive format.');
  throw new Error('Kernel member missing from archive.');
}
