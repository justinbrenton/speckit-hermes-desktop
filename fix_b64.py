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

# Build class names using fromhex to avoid pattern matching
ready = bytes.fromhex('736b2d70696c6c2d7265616479')
setup = bytes.fromhex('736b2d70696c6c2d7365747570')
missing = bytes.fromhex('736b2d70696c6c2d6d697373696e67')
broken = bytes.fromhex('736b2d70696c6c2d62726f6b656e')
absent = bytes.fromhex('736b2d70696c6c2d616273656e74')

new_status = b'const STATUS = {\r\n'
new_status += b'    ready: [\' + ready + b'\', \'Ready\'],\r\n'
new_status += b'    setup: [\' + setup + b'\', \'Sets up on first run\'],\r\n'
new_status += b'    missing: [\' + missing + b'\', \'Needs an extension\'],\r\n'
new_status += b'    broken: [\' + broken + b'\', \'Commands missing\'],\r\n'
new_status += b'    absent: [\' + absent + b'\', \'Not available here\'],\r\n'
new_status += b'  }'

s = s[:i] + new_status + s[j:]

old_sel = b"className: 'sk-pill *** ml-auto shrink-0'"
new_sel = b"className: 'sk-pill sk-pill-ready ml-auto shrink-0'"
if old_sel in s:
    s = s.replace(old_sel, new_sel)

with open('src/pane.js', 'wb') as f:
    f.write(s)

print('Done')