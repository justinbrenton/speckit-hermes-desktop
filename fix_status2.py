with open('src/pane.js', 'rb') as f:
    s = f.read()

# Replace each occurrence
s = s.replace(b"ready: ['***', 'Ready']", b"ready: ['sk-pill-ready', 'Ready']")
s = s.replace(b"setup: ['***', 'Sets up on first run']", b"setup: ['sk-pill-setup', 'Sets up on first run']")
s = s.replace(b"missing: ['***', 'Needs an extension']", b"missing: ['sk-pill-missing', 'Needs an extension']")
s = s.replace(b"broken: ['***', 'Commands missing']", b"broken: ['sk-pill-broken', 'Commands missing']")
s = s.replace(b"absent: ['***', 'Not available here']", b"absent: ['sk-pill-absent', 'Not available here']")

with open('src/pane.js', 'wb') as f:
    f.write(s)

print('Done')
