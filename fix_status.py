with open('src/pane.js', 'rb') as f:
    s = f.read()

i = s.find(b'const STATUS = {')
depth = 0
j = i
for k in range(i, min(i+500, len(s))):
    if s[k:k+1] == b'{':
        depth += 1
    elif s[k:k+1] == b'}':
        depth -= 1
        if depth == 0:
            j = k + 1
            break

parts = [
    b'const STATUS = {\r\n',
    b"    ready: ['sk-pill-ready', 'Ready'],\r\n",
    b"    setup: ['sk-pill-setup', 'Sets up on first run'],\r\n",
    b"    missing: ['sk-pill-missing', 'Needs an extension'],\r\n",
    b"    broken: ['sk-pill-broken', 'Commands missing'],\r\n",
    b"    absent: ['sk-pill-absent', 'Not available here'],\r\n",
    b'  }'
]
new_status = b''.join(parts)

s = s[:i] + new_status + s[j:]

with open('src/pane.js', 'wb') as f:
    f.write(s)

print('Done')
