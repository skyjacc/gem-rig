const fs=require('fs'),path=require('path'),zlib=require('zlib');

function readVpkTree(dirPath){
  const b=fs.readFileSync(dirPath);
  let o=0;
  const sig=b.readUInt32LE(o);o+=4;
  if(sig!==0x55aa1234) throw new Error('bad vpk signature');
  const ver=b.readUInt32LE(o);o+=4;
  const treeSize=b.readUInt32LE(o);o+=4;
  if(ver===2) o+=16;
  const treeStart=o, treeEnd=o+treeSize;
  const files=[];
  function str(){ let s=o; while(b[o]!==0)o++; const v=b.toString('latin1',s,o); o++; return v; }
  while(o<treeEnd){
    const ext=str(); if(!ext)break;
    while(o<treeEnd){
      const dir=str(); if(!dir)break;
      while(o<treeEnd){
        const name=str(); if(!name)break;
        const crc=b.readUInt32LE(o);o+=4;
        const preloadBytes=b.readUInt16LE(o);o+=2;
        const archiveIndex=b.readUInt16LE(o);o+=2;
        const entryOffset=b.readUInt32LE(o);o+=4;
        const entryLength=b.readUInt32LE(o);o+=4;
        o+=2; // terminator
        const preloadOffset=o; o+=preloadBytes;
        files.push({path:(dir==='  '?'':dir+'/')+name+'.'+ext,archiveIndex,entryOffset,entryLength,preloadBytes,preloadOffset});
      }
    }
  }
  return {buf:b,files,ver,treeEnd};
}

function readFile(dirPath,dirBuf,e){
  const parts=[];
  if(e.preloadBytes) parts.push(dirBuf.subarray(e.preloadOffset,e.preloadOffset+e.preloadBytes));
  if(e.entryLength){
    if(e.archiveIndex===0x7fff){
      parts.push(dirBuf.subarray(e.entryOffset,e.entryOffset+e.entryLength));
    } else {
      const num=String(e.archiveIndex).padStart(3,'0');
      const ap=dirPath.replace(/_dir\.vpk$/,'_'+num+'.vpk');
      const fd=fs.openSync(ap,'r');
      const buf=Buffer.alloc(e.entryLength);
      fs.readSync(fd,buf,0,e.entryLength,e.entryOffset);
      fs.closeSync(fd);
      parts.push(buf);
    }
  }
  return Buffer.concat(parts);
}
module.exports={readVpkTree,readFile};
