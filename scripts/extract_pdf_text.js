import fs from 'fs';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

async function extract(filePath, maxPages = Number.MAX_SAFE_INTEGER){
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjsLib.getDocument({data});
  const pdf = await loadingTask.promise;
  const out = [];
  const pageCount = Math.min(pdf.numPages, maxPages);
  for(let i=1;i<=pageCount;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // build text
    const lines = [];
    let currentY = null;
    let line = '';
    for(const item of content.items){
      const y = Math.round(item.transform[5]);
      if(currentY === null) currentY = y;
      if(Math.abs(y-currentY) > 5){
        if(line.trim()) lines.push(line.trim());
        line = '';
        currentY = y;
      }
      line += item.str + ' ';
    }
    if(line.trim()) lines.push(line.trim());
    out.push({page:i, text: lines.join('\n')});
  }
  return out;
}

(async ()=>{
  try{
    const filePath = process.argv[2] || path.resolve('d:','New download','test.pdf');
    if(!fs.existsSync(filePath)){
      console.error('File not found:', filePath);
      process.exit(2);
    }
    const pages = await extract(filePath, 5);
    for(const p of pages){
      console.log('--- PAGE',p.page,'---\n');
      console.log(p.text.slice(0,5000));
      console.log('\n\n');
    }
  }catch(err){
    console.error(err);
    process.exit(1);
  }
})();
