import sys,json
comments=json.load(sys.stdin)
for c in comments[-3:]:
    print(f'{c["user"]["login"]} ({c["created_at"]}): {c["body"][:200]}')
