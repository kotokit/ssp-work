import re
p = '/Users/illia/Downloads/adx-ja.py'
s = open(p).read()

# 1. full source IP instead of /24
s = s.replace(
    "        srcip = '.'.join(str(b) for b in ip[12:15]) + '.0/24'",
    "        srcip = '.'.join(str(b) for b in ip[12:16])"
)
s = s.replace(
    "        srcip = ip[8:14].hex() + '::/48'",
    "        srcip = ':'.join(ip[8:24].hex()[i:i+4] for i in range(0, 32, 4))"
)
# docstring
s = s.replace('Source IPs are cut to /24 before anything is written.',
              'Source IPs are written in full (pass --anonymise to mask the host octet).')
open(p, 'w').write(s)
print('patched')
