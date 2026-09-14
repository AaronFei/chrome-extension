// 極簡 PDF 產生器：把一張長圖切成多頁，每頁嵌一張 JPEG（DCTDecode）。
// 沒有任何外部相依（MV3 不允許載入遠端程式碼）。

const A4 = { w: 595.28, h: 841.89 };

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h); // service worker
}

async function canvasToJpegBytes(c, quality) {
  const blob = c.convertToBlob
    ? await c.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function imageToPdfBlob(source, opts = {}) {
  const pageW = opts.pageW || A4.w;
  const pageH = opts.pageH || A4.h;
  const margin = opts.margin != null ? opts.margin : 24;
  const quality = opts.quality || 0.92;

  const imgW = source.width;
  const imgH = source.height;
  const contentW = pageW - margin * 2;
  const contentH = pageH - margin * 2;
  const scale = contentW / imgW; // pt / px
  const sliceH = Math.max(1, Math.floor(contentH / scale));
  const pages = Math.max(1, Math.ceil(imgH / sliceH));

  const imgs = [];
  for (let i = 0; i < pages; i++) {
    const h = Math.min(sliceH, imgH - i * sliceH);
    if (h <= 0) break;
    const c = makeCanvas(imgW, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, imgW, h);
    ctx.drawImage(source, 0, i * sliceH, imgW, h, 0, 0, imgW, h);
    imgs.push({ bytes: await canvasToJpegBytes(c, quality), w: imgW, h });
  }

  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const push = (u8) => {
    chunks.push(u8);
    len += u8.length;
  };
  const S = (s) => push(enc.encode(s));

  const n = 2 + imgs.length * 3;
  const offsets = new Array(n + 1).fill(0);
  const begin = (num) => {
    offsets[num] = len;
    S(`${num} 0 obj\n`);
  };
  const end = () => S('endobj\n');
  const f = (x) => (Math.round(x * 100) / 100).toString();

  S('%PDF-1.4\n');

  begin(1);
  S('<< /Type /Catalog /Pages 2 0 R >>\n');
  end();

  const kids = imgs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  begin(2);
  S(`<< /Type /Pages /Count ${imgs.length} /Kids [${kids}] >>\n`);
  end();

  imgs.forEach((im, i) => {
    const pObj = 3 + i * 3;
    const cObj = pObj + 1;
    const xObj = pObj + 2;
    const drawW = contentW;
    const drawH = im.h * scale;
    const x = margin;
    const y = pageH - margin - drawH;

    begin(pObj);
    S(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pageW)} ${f(pageH)}] ` +
        `/Resources << /XObject << /Im0 ${xObj} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
        `/Contents ${cObj} 0 R >>\n`
    );
    end();

    const content = `q ${f(drawW)} 0 0 ${f(drawH)} ${f(x)} ${f(y)} cm /Im0 Do Q\n`;
    begin(cObj);
    S(`<< /Length ${enc.encode(content).length} >>\nstream\n`);
    S(content);
    S('endstream\n');
    end();

    begin(xObj);
    S(
      `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`
    );
    push(im.bytes);
    S('\nendstream\n');
    end();
  });

  const xrefPos = len;
  S(`xref\n0 ${n + 1}\n`);
  S('0000000000 65535 f \n');
  for (let i = 1; i <= n; i++) {
    S(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }
  S(`trailer\n<< /Size ${n + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
