
const fs = require('node:fs');
const path = require('node:path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

async function generateResume(payload) {
  const templatePath = path.resolve(
    process.env.RESUME_TEMPLATE_PATH ||
      path.join(process.cwd(), 'templates', 'resume-template.docx')
  );

  if (!fs.existsSync(templatePath)) {
    const err = new Error(
      `DOCX template not found at ${templatePath}.`
    );
    err.statusCode = 500;
    throw err;
  }

  const zip = new PizZip(
    fs.readFileSync(templatePath, 'binary')
  );

  let doc;

  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: {
        start: '{{',
        end: '}}'
      },
      nullGetter: () => ''
    });

    doc.render({
      candidate: payload.candidate,
      // Page 1 (skills, education, summary, key highlights) must fit on one page, so employer-level
      // "experience" entries are deliberately not rendered under the highlights. Project detail
      // pages carry the experience. The field is still accepted so existing callers keep working.
      resumeContent: pageOneContent(payload.resumeContent),
      generatedOn: new Date().toISOString().slice(0, 10)
    });

    const outZip = doc.getZip();
    outZip.file('word/document.xml', removeLoopGaps(outZip.file('word/document.xml').asText()));
  } catch (err) {
    const details = Array.isArray(err.properties?.errors)
      ? err.properties.errors
          .map(e => e.properties?.explanation || e.message)
          .join('; ')
      : err.message;

    const wrapped = new Error(
      `Could not render DOCX template: ${details}`
    );
    wrapped.statusCode = 400;
    throw wrapped;
  }

  return doc.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  });
}

/**
 * The "Professional summary and Key highlights" section must be a bullet list only.
 * The template prints the summary as a plain paragraph above the bullets, so the summary is folded
 * in as the first bullet and the paragraph is left empty (and removed by removeLoopGaps).
 * `experience` is accepted but not rendered, see generateResume().
 */
function pageOneContent(content) {
  const hasText = rt => (rt?.segments || []).some(seg => String(seg.text || '').trim());
  const highlights = content.highlights || [];
  return {
    ...content,
    summary: { segments: [] },
    highlights: hasText(content.summary) ? [content.summary, ...highlights] : highlights,
    experience: []
  };
}

const PARAGRAPH = /<w:p[ >](?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g;

/**
 * Template loop tags ({{#highlights}} ... {{/highlights}} etc.) sit in their own paragraphs, and
 * docxtemplater leaves those paragraphs behind as empty lines, one per loop iteration. In the
 * summary/highlights table that put a blank line between every bullet and pushed content onto
 * page 2. Remove only paragraphs that are provably empty gaps inside that main table:
 * no text, no picture/bullet/break/bookmark/field, the template's 0/0/240 loop-tag spacing,
 * and not the last paragraph of a cell (Word requires one).
 */
function removeLoopGaps(xml) {
  const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
  const main = tables.find(t => t.includes('Professional summary and Key highlights'));
  if (!main) return xml;

  const isGap = p =>
    !/<w:t[^>]*>[^<]+<\/w:t>/.test(p) &&
    !/<w:(drawing|pict|numPr|br|bookmarkStart|bookmarkEnd|fldChar|fldSimple|sectPr|tab)[ />]/.test(p) &&
    (/<w:spacing w:before="0" w:after="0" w:line="240"/.test(p) ||
      /<w:spacing w:before="240" w:after="120" w:line="324"/.test(p));

  const tightened = main.replace(
    new RegExp(`(${PARAGRAPH.source})(?=\\s*<w:p[ >])`, 'g'),
    p => (isGap(p) ? '' : p)
  );
  return xml.replace(main, () => tightened);
}

module.exports = { generateResume, removeLoopGaps };
