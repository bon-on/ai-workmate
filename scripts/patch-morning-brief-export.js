import fs from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: node patch-morning-brief-export.js <input> <output>');

const workflow = JSON.parse(fs.readFileSync(inputPath, 'utf8'))[0];
const source = fs.readFileSync(new URL('../workflows/personal-ops-morning-brief.n8n.js', import.meta.url), 'utf8');
const codeMatch = source.match(/name: 'Prepare Morning Brief Translations',[\s\S]*?jsCode: `([\s\S]*?)`,\n    },/);
if (!codeMatch) throw new Error('Could not read the updated briefing preparation code');

const prepare = workflow.nodes.find((node) => node.name === 'Prepare Morning Brief Translations');
const combine = workflow.nodes.find((node) => node.name === 'Combine Morning Sources');
const trigger = workflow.nodes.find((node) => node.name === 'Weekday 8AM');
if (!prepare || !combine || !trigger) throw new Error('Expected nodes are missing from the exported workflow');

// Keep the schedule anchored to Korean local time even when the n8n instance
// has a different default timezone (for example, America/New_York).
workflow.settings = { ...workflow.settings, timezone: 'Asia/Seoul' };
trigger.parameters.rule = {
  interval: [{ field: 'cronExpression', expression: '0 0 8 * * 1-5' }],
};

// The workflow source stores code inside a JavaScript template literal, so its
// regex escapes are doubled in the source text. n8n needs the evaluated form.
prepare.parameters.jsCode = codeMatch[1].replace(/\\\\/g, '\\');
combine.parameters.numberInputs = 8;

const fallbackName = 'Seoul Weather Fallback';
workflow.nodes = workflow.nodes.filter((node) => node.name !== fallbackName);
workflow.nodes.push({
  id: '4f0e5d4a-3dbb-4bb0-bd76-bf4e35a0c02e',
  name: fallbackName,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position: [520, 120],
  parameters: {
    method: 'GET',
    url: 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=37.5665&lon=126.9780',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'user-agent', value: 'AI-Workmate-Morning-Brief/1.0 contact@example.invalid' }] },
    options: { timeout: 15000, response: { response: { responseFormat: 'json', neverError: true } } },
  },
});

for (const [sourceName, outputs] of Object.entries(workflow.connections)) {
  for (const output of outputs.main || []) {
    for (const connection of output || []) {
      if (connection.node === 'Combine Morning Sources' && connection.index >= 1) connection.index += 1;
    }
  }
}
workflow.connections['Weekday 8AM'].main[0].push({ node: fallbackName, type: 'main', index: 0 });
workflow.connections[fallbackName] = { main: [[{ node: 'Combine Morning Sources', type: 'main', index: 1 }]] };

fs.writeFileSync(outputPath, JSON.stringify([workflow]));
