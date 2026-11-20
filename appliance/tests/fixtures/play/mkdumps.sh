set -u
# Run as root on a lab box with Docker and the games API image running as tinhat-api-1; writes the dumps to $OUT.
N=g1ref-$$; NET=g1net-$$; OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"
ADMIN_PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+='); PLAY_PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
docker network create $NET >/dev/null
docker run -d --rm --name $N --network $NET -e POSTGRES_USER=synapse -e POSTGRES_PASSWORD="$ADMIN_PW" -e POSTGRES_DB=synapse postgres:17-alpine >/dev/null
for i in $(seq 40); do docker exec $N pg_isready -U synapse -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker exec $N psql -X -q -U synapse -d postgres -v pw="$PLAY_PW" -c "CREATE ROLE tinhat_play LOGIN" -c "ALTER ROLE tinhat_play PASSWORD :'pw'" -c "CREATE DATABASE tinhat_play OWNER tinhat_play ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"
cat > $OUT/seed.mjs <<'JS'
import pg from "pg";
import { migrate, inTx } from "/opt/tinhat-api/tinhat-api/play/db.mjs";
import * as L from "/opt/tinhat-api/tinhat-api/play/ledger.mjs";
import * as rules from "/opt/tinhat-api/tinhat-api/play/rules.mjs";
const pool = new pg.Pool({ host: process.env.H, port: 5432, database: "tinhat_play", user: "tinhat_play", password: process.env.PW });
await migrate(pool);
if (process.env.SEED === "1") {
  const cfg = { ...rules.configFromEnv({}), tz: "UTC" };
  const sid = await inTx(pool, (c) => L.ensureSpace(c, "!g1space:ref.example", "ref.example"));
  for (const u of ["@g1-a:ref.example", "@g1-b:ref.example", "@g1-c:ref.example"]) await inTx(pool, (c) => L.createWallet(c, { sid, user: u, cfg, salt: "g1-salt" }));
  console.log("audit:", JSON.stringify(await inTx(pool, (c) => L.audit(c))));
}
console.log("migrated");
await pool.end();
JS
IMG=$(docker inspect -f '{{.Config.Image}}' tinhat-api-1)
docker run --rm --network $NET -e H=$N -e SEED=1 -e PW="$PLAY_PW" -v $OUT/seed.mjs:/opt/tinhat-api/tinhat-api/g1seed.mjs:ro -w /opt/tinhat-api/tinhat-api --entrypoint node $IMG g1seed.mjs
D() { docker exec $N pg_dump -U synapse -Fc tinhat_play > $OUT/$1.dump; echo "$1: $(wc -c < $OUT/$1.dump) bytes"; }
D play-v2
docker exec $N psql -X -q -U synapse -d tinhat_play -c "CREATE FUNCTION public.g1_evil() RETURNS int LANGUAGE sql AS 'SELECT 1'"; D planted-function
docker exec $N psql -X -q -U synapse -d tinhat_play -c "DROP FUNCTION public.g1_evil()" -c "DROP TRIGGER play_entries_ro ON play_entries"; D planted-missing-trigger
docker exec $N psql -X -q -U synapse -d tinhat_play -c "CREATE TRIGGER play_entries_ro BEFORE UPDATE OR DELETE ON play_entries FOR EACH ROW EXECUTE FUNCTION play_append_only()" -c "CREATE VIEW public.g1_view AS SELECT * FROM play_people"; D planted-view
docker exec $N psql -X -q -U synapse -d tinhat_play -c "DROP VIEW public.g1_view" -c "CREATE TABLE public.g1_extra (x int)"; D planted-table
docker exec $N psql -X -q -U synapse -d tinhat_play -c "DROP TABLE public.g1_extra" -c "ALTER TABLE play_people ADD COLUMN g1_col text"; D planted-column
docker exec $N psql -X -q -U synapse -d tinhat_play -c "ALTER TABLE play_people DROP COLUMN g1_col" -c "ALTER TABLE play_wallets ALTER COLUMN rank SET DEFAULT (length(pg_read_file('/etc/hostname')))"; D planted-default
docker exec $N pg_dump --version
docker stop $N >/dev/null; docker network rm $NET >/dev/null; echo "throwaway removed"
echo "dumps in $OUT"
