with open('src/pane.js', 'rb') as f:
    s = f.read()

# Find STATUS block
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

# Build class names as bytes to avoid any string processing
ready = b'sk-pill-ready'
setup = b'sk-pill-setup'
missing = b'sk-pill-missing'
broken = b'sk-pill-broken'
absent = b'sk-pill-absent'

new_status = b"const STATUS = {\r\n"
new_status += b"    ready: ['" + ready + b"', 'Ready'],\r\n"
new_status += b"    setup: ['" + setup + b"', 'Sets up on first run'],\r\n"
new_status += b"    missing: ['" + missing + b"', 'Needs an extension'],\r\n"
new_status += b"    broken: ['" + broken + b"', 'Commands missing'],\r\n"
new_status += b"    absent: ['" + absent + b"', 'Not available here'],\r\n"
new_status += b"  }"

s = s[:i] + new_status + s[j:]

# Fix PathChoice selected pill
old_sel = b"className: 'sk-pill *** ml-auto shrink-0'"
new_sel = b"className: 'sk-pill sk-pill-ready ml-auto shrink-0'"
if old_sel in s:
    s = s.replace(old_sel, new_sel)

with open('src/pane.js', 'wb') as f:
    f.write(s)

print('Done')