
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
      resumeContent: payload.resumeContent,
      generatedOn: new Date().toISOString().slice(0, 10)
    });
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

module.exports = { generateResume };
