/**
 * Ordinary developer commands, verbatim (owner lever D, 2026-10-12). `\n` is a real newline. An entry with
 * `knownFriction` is pinned to what the policy does today and is listed for the owner; every other entry must run with
 * no friction beyond the ordinary exec question.
 */
export interface CorpusEntry {
  readonly command: string;
  /** What the policy does today, asserted as it is: the reason for the owner, stage 01's verdict and its reason. */
  readonly knownFriction?: {
    readonly why: string;
    readonly stage01: "ask" | "block";
    readonly reason: string;
  };
}

export const BASH_CORPUS: readonly CorpusEntry[] = [
  { command: `git status` },
  { command: `git diff --stat HEAD~3` },
  { command: `git log --oneline -20` },
  { command: `git add -A && git commit -m "fix: handle empty input"` },
  { command: `git switch -c feat/search && git push -u origin feat/search` },
  { command: `git push --force-with-lease origin feat/search` },
  { command: `git rebase main` },
  { command: `git stash push -u -m "wip-search"` },
  { command: `git clean -n` },
  { command: `pnpm install --frozen-lockfile` },
  { command: `pnpm test -- --run src/foo.test.ts` },
  { command: `npm run build 2>&1 | tail -50` },
  { command: `npx tsc --noEmit` },
  { command: `node scripts/check.mjs --verbose` },
  { command: `python3 -m pytest -q tests/` },
  {
    command: `python3 - <<'EOF'\nimport json\nimport sys\n\n\ndef main():\n    with open("data.json") as handle:\n        rows = json.load(handle)\n    for row in rows:\n        if row.get("active"):\n            print(f"{row['id']}: {row['name']}")\n    return 0\n\n\nif __name__ == "__main__":\n    sys.exit(main())\nEOF`,
  },
  { command: `cat > src/config.json <<'EOF'\n{ "name": "demo", "port": 8080 }\nEOF` },
  {
    command: `cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\ndata:\n  mode: staging\nEOF`,
  },
  {
    command: `psql "$DATABASE_URL" <<'SQL'\nSELECT count(*) FROM users WHERE created_at > now() - interval '1 day';\nSQL`,
  },
  { command: `docker build -t app:dev . && docker run --rm -p 8080:8080 app:dev` },
  { command: `docker compose up -d && docker compose logs --tail=100 api` },
  { command: `podman ps -a` },
  { command: `kubectl get pods -n staging -o wide` },
  { command: `kubectl logs deploy/api -n staging --since=10m | grep -i error` },
  { command: `terraform plan -out=tfplan` },
  { command: `helm upgrade --install api ./chart -f values.yaml --dry-run` },
  { command: `curl -s http://localhost:3000/health | jq .` },
  { command: `curl -fsSL -o vendor/x.tar.gz https://example.com/x.tar.gz` },
  { command: `wget -q https://example.com/file.txt` },
  { command: `rm -rf dist node_modules/.cache` },
  { command: `rm -rf ./build && mkdir -p build` },
  { command: `find . -name '*.orig' -delete` },
  { command: `find src -type f -name '*.ts' | xargs grep -l 'TODO'` },
  { command: `rg -n "useEffect" src/` },
  { command: `sed -i 's/oldName/newName/g' src/a.ts src/b.ts` },
  { command: `awk -F, '{print $2}' data.csv | sort | uniq -c` },
  { command: `tar -czf backup.tgz src/ docs/` },
  { command: `chmod +x scripts/deploy.sh && ./scripts/deploy.sh --dry-run` },
  { command: `make test` },
  { command: `go test ./... -run TestParse` },
  { command: `cargo build --release` },
  { command: `for f in src/*.ts; do echo "$f"; wc -l "$f"; done` },
  { command: `while read -r line; do echo "$line"; done < input.txt` },
  { command: `export NODE_ENV=production && node dist/main.js --check` },
  { command: `env DEBUG=1 pnpm dev` },
  { command: `timeout 30 pnpm test:int` },
  { command: `ls -la ~/.config/app/` },
  { command: `echo "$(date +%F) deploy" >> CHANGELOG.md` },
  { command: `ssh deploy@staging.example.com 'systemctl --user restart app'` },
  { command: `systemctl --user status app && journalctl --user -u app -n 50` },
  { command: `kill -TERM 12345` },
  { command: `jq '.dependencies | keys' package.json` },
];
