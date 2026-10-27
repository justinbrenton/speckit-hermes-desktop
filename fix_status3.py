with open('src/pane.js', 'rb') as f:
    s = f.read()

# Replace using the exact bytes from the file
# The file uses CRLF line endings
replacements = [
    (b"ready: ['***', 'Ready'],\r\n", b"ready: ['sk-pill-ready', 'Ready'],\r\n"),
    (b"setup: ['***', 'Sets up on first run'],\r\n", b"setup: ['sk-pill-setup', 'Sets up on first run'],\r\n"),
    (b"missing: ['***', 'Needs an extension'],\r\n", b"missing: ['sk-pill-missing', 'Needs an extension'],\r\n"),
    (b"broken: ['***', 'Commands missing'],\r\n", b"broken: ['sk-pill-broken', 'Commands missing'],\r\n"),
    (b"absent: ['***', 'Not available here'],\r\n", b"absent: ['sk-pill-absent', 'Not available here'],\r\n"),
    # Also fix the PathChoice selected pill
    (b"className: 'sk-pill *** ml-auto shrink-0'", b"className: 'sk-pill sk-pill-ready ml-auto shrink-0'"),
]

for old, new in replacements:
    if old in s:
        s = s.replace(old, new)
        print(f'Replaced: {old[:40]}')
    else:
        print(f'NOT FOUND: {old[:40]}')

with open('src/pane.js', 'wb') as f:
    f.write(s)

print('Done')
