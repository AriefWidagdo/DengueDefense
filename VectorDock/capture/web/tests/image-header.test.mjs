import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { imageDimensions, inspectPhotoFile } from "../js/lib/image-header.js";
import { deriveUploadState, UI_STATE, shouldPoll } from "../js/lib/status.js";
import { scanQrCodes } from "../js/lib/qr-scan.js";

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8,13); view.setUint32(12,0x49484452);
  view.setUint32(16,width); view.setUint32(20,height);
  return bytes;
}

test("rejects a compressed high-pixel PNG header before bitmap allocation", async () => {
  const bytes=pngHeader(5000,4000);
  assert.throws(()=>imageDimensions(bytes), /16 megapixels/);
  await assert.rejects(inspectPhotoFile(new Blob([bytes],{type:"image/png"})),/16 megapixels/);
});
test("checks zero dimensions, non-image bytes and the inclusive 16 MP boundary",()=>{
  assert.throws(()=>imageDimensions(pngHeader(0,4000)), /dimension header/);
  assert.throws(()=>imageDimensions(new Uint8Array(24)), /dimension header/);
  assert.equal(imageDimensions(pngHeader(4000,4000)).width,4000);
});
test("reads actual JPEG and PNG fixtures without decoding pixels",async()=>{
  const png=await readFile(new URL("fixtures/photo-qr-token.png",import.meta.url));
  const jpg=await readFile(new URL("fixtures/photo-qr-token-exif6.jpg",import.meta.url));
  assert.equal(imageDimensions(png).format,"png");
  assert.equal(imageDimensions(jpg).format,"jpeg");
});
test("rejects a large Blob before even reading its body",async()=>{
  let read=false;
  await assert.rejects(inspectPhotoFile({size:13*1024*1024,arrayBuffer(){read=true;return new ArrayBuffer(0);}}), /12 MiB/);
  assert.equal(read,false);
});
test("tile scan does not mistake a map plus one ID for complete conflict evidence",()=>{
  let calls=0;
  const location={topLeftCorner:{x:0,y:0},topRightCorner:{x:1,y:0},bottomLeftCorner:{x:0,y:1},bottomRightCorner:{x:1,y:1}};
  const sequence=[null,"https://www.google.com/maps/search/?api=1&query=TEST","VD1:TRAP:VD-001",null,"VD1:TRAP:VD-002"];
  const result=scanQrCodes(new Uint8ClampedArray(40*40*4),40,40,()=>{
    const data=sequence[calls++]; return data?{data,location}:null;
  });
  assert.ok(result.includes("VD1:TRAP:VD-002"));
});
test("dispatch budget exhaustion is terminal attention, not an endless queue",()=>{
  const status=deriveUploadState({status:"stored",processing:{state:"queued",needs_attention:true}});
  assert.equal(status.state,UI_STATE.NEEDS_ATTENTION);
  assert.equal(shouldPoll(status),false);
  assert.match(status.detail,/supervisor/);
});
