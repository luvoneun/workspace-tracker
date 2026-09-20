const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
let observer = null;
const observeWrites = fn => { observer = fn; };

// One atomic replacement; retain the previous version for recovery.
function atomicWrite(filename, content) {
  if (observer) observer(filename, content);
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    if (fs.existsSync(filename)) {
      const backup = path.join(path.dirname(filename), '.backups');
      fs.mkdirSync(backup, { recursive: true });
      fs.copyFileSync(filename, path.join(backup, `${path.basename(filename)}.previous`));
    }
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
module.exports = { atomicWrite, observeWrites };
