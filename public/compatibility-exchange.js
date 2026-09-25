// SPDX-License-Identifier: GPL-2.0-only
// This is an in-tab MEMFS directory exported to the guest through virtio-9P.
// It never mounts a host directory or grants the guest access to native files.
const LIMIT = 64 * 1024 * 1024;
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 200
  && !/[\/\\\x00-\x1f\x7f]/.test(name) && !name.startsWith('.');

export function connectExchange(FS, {input, upload, refresh, list, message}) {
  let active = true;
  const describe = text => {message.textContent = text;};
  function files() {
    return FS.readdir('/exchange').filter(validName).map(name => {
      const stat = FS.lstat('/exchange/' + name);
      return {name, stat};
    }).filter(({stat}) => FS.isFile(stat.mode));
  }
  function show() {
    if (!active) return;
    try {
      list.replaceChildren(...files().map(({name, stat}) => {
        const row = document.createElement('li'), button = document.createElement('button');
        const label = document.createElement('span');
        label.textContent = `${name} · ${(stat.size / 1024).toFixed(1)} KiB`;
        button.textContent = 'Download'; button.disabled = stat.size > LIMIT;
        button.onclick = () => {
          try {
            const path = '/exchange/' + name, current = FS.lstat(path);
            if (!FS.isFile(current.mode) || current.size > LIMIT) throw new Error('Only regular files up to 64 MiB can be downloaded.');
            const bytes = FS.readFile(path), url = URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'}));
            const link = document.createElement('a'); link.href = url; link.download = name;
            document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          } catch (error) {describe(error.message);}
        };
        row.append(label, button); return row;
      }));
    } catch (error) {describe(error.message);}
  }
  upload.disabled = false; refresh.disabled = false;
  upload.onclick = () => input.click(); refresh.onclick = show;
  input.onchange = async () => {
    upload.disabled = true;
    try {
      for (const file of input.files) {
        if (!validName(file.name)) throw new Error('Use a filename without slashes, control characters or a leading dot.');
        const total = files().reduce((sum, item) => sum + item.stat.size, 0);
        if (file.size > LIMIT || total + file.size > LIMIT) throw new Error('The exchange holds up to 64 MiB. Move files into Linux and remove exchanged copies before adding more.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!active) return;
        let name = file.name, suffix = 1;
        while (FS.analyzePath('/exchange/' + name).exists) name = `${file.name.slice(0, 180)}-${suffix++}`;
        FS.writeFile('/exchange/' + name, bytes, {canOwn: true});
        describe(`Available in Linux at /mnt/browser/${name}. Copy it into the Linux disk to include it in a disk save.`);
      }
      show();
    } catch (error) {describe(error.message);}
    finally {input.value = ''; upload.disabled = !active;}
  };
  show();
  return () => {active = false; upload.disabled = true; refresh.disabled = true; input.onchange = null;};
}
