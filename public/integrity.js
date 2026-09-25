// SPDX-License-Identifier: GPL-2.0-only
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
export async function fingerprint(snapshot) {
  const records = [];
  for (const entry of [...snapshot.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const hash = entry.type === 'file' ? hex(await crypto.subtle.digest('SHA-256', entry.data)) : null;
    records.push([entry.path, entry.type, entry.target || null, hash]);
  }
  return 'sha256:' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(records))));
}
export async function verifySnapshot(snapshot) {
  const digest = await fingerprint(snapshot);
  if (snapshot.digest && snapshot.digest !== digest) throw new Error('Backup integrity check failed. The saved files were not changed.');
  return digest;
}
