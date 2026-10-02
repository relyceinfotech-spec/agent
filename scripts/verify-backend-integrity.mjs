import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Install the pinned optional verification engine outside the workspace, then
// set PGLITE_MODULE to its dist/index.js. This never connects to Supabase.
if (!process.env.PGLITE_MODULE)
  throw new Error("Set PGLITE_MODULE to the installed @electric-sql/pglite@0.5.8 dist/index.js");
const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE)).href);
const db = new PGlite();
const query = (sql, params = []) => db.query(sql, params);
const rejects = (sql, params, pattern) => assert.rejects(query(sql, params), pattern);
let checks = 0;
try {
  await db.exec(`create role authenticator; create role anon; create role authenticated;
    create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to anon,authenticated,service_role;`);
  for (const file of readdirSync(resolve("supabase/migrations")).sort()) {
    // Memory vector migrations require pgvector and do not touch these controls.
    if (file.includes("memor")) continue;
    await db.exec(readFileSync(resolve("supabase/migrations", file), "utf8"));
  }
  const owner = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const job = "33333333-3333-4333-8333-333333333333";
  const competitor = "44444444-4444-4444-8444-444444444444";
  await query("insert into auth.users(id) values($1),($2)", [owner, other]);
  await query("set role service_role");
  const enqueue = (id, sessionId, key = null) =>
    query(
      `select research.max_enqueue_job($1,'research',$2,$3,$4,$5,3,'research',86400,20) as result`,
      [
        id,
        owner,
        `user:${owner}`,
        key,
        JSON.stringify({ sessionId, question: "Explain leases", mode: "quick" }),
      ],
    );
  const first = await enqueue(job, "session", "once");
  assert.equal(first.rows[0].result.created, true);
  assert.equal((await enqueue(competitor, "session", "once")).rows[0].result.created, false);
  checks++;
  await rejects(
    `select research.max_enqueue_job($1,'research',$2,$3,null,$4,3,'research',86400,20)`,
    [competitor, owner, `user:${owner}`, JSON.stringify({ sessionId: "session" })],
    /unique/i,
  );
  assert.equal(
    (
      await query(
        "select used from research.max_user_quota_windows where user_id=$1 and quota_key='research'",
        [owner],
      )
    ).rows[0].used,
    1,
  );
  checks++;
  const lease = (await query("select research.max_claim_job_by_id('worker',45,$1) as job", [job]))
    .rows[0].job;
  assert.equal(lease.id, job);
  checks++;
  const now = new Date().toISOString();
  const session = {
    id: "session",
    question: "Explain leases",
    mode: "quick",
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    sources: [],
    claims: [],
    steps: [],
  };
  const write = (data, generation = 1, create = false, ownerId = owner) =>
    query("select research.max_write_worker_session($1,$2,$3,$4,'worker',$5)", [
      JSON.stringify(data),
      ownerId,
      create,
      job,
      generation,
    ]);
  await write(session, 1, true);
  await assert.rejects(
    write({ ...session, answer: "foreign" }, 1, false, other),
    /owner mismatch/i,
  );
  await query("update research.max_jobs set lease_generation=2 where id=$1", [job]);
  await assert.rejects(write({ ...session, answer: "stale" }), /lease was lost/i);
  assert.equal(
    (await query("select data from research.max_research_sessions where id='session'")).rows[0].data
      .answer,
    undefined,
  );
  checks += 2;
  await write({ ...session, answer: "current" }, 2);
  await query("update research.max_jobs set status='cancel_requested' where id=$1", [job]);
  await assert.rejects(write({ ...session, status: "COMPLETED" }, 2), /lease was lost/i);
  await write({ ...session, status: "CANCELLED" }, 2);
  checks++;
  await query("select research.max_delete_research_session('session',$1)", [other]);
  assert.equal(
    (
      await query(
        "select count(*)::int as count from research.max_research_sessions where id='session'",
      )
    ).rows[0].count,
    1,
  );
  await query("select research.max_delete_research_session('session',$1)", [owner]);
  assert.equal(
    (
      await query(
        "select count(*)::int as count from research.max_deleted_research_sessions where id='session'",
      )
    ).rows[0].count,
    1,
  );
  await query("update research.max_jobs set status='running' where id=$1", [job]);
  await assert.rejects(write(session, 2, true), /was deleted/i);
  checks += 2;
  await query(
    "update research.max_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [job],
  );
  await assert.rejects(write(session, 2, true), /lease was lost/i);
  checks++;
  await assert.rejects(
    query("update research.max_jobs set lease_expires_at=null where id=$1", [job]),
    /check constraint/i,
  );
  checks++;
  const key = "a".repeat(64);
  const rate = () => query("select research.max_consume_rate_limit($1,60000,1) as result", [key]);
  assert.equal((await rate()).rows[0].result.allowed, true);
  assert.equal((await rate()).rows[0].result.allowed, false);
  await query(
    "update research.max_request_rate_limits set window_end=clock_timestamp()-interval '1 second' where key=$1",
    [key],
  );
  assert.equal((await rate()).rows[0].result.allowed, true);
  checks++;
  await query("reset role");
  const privileges = (
    await query(`select has_any_column_privilege('authenticated','content.max_exports','INSERT') as insert,
    has_any_column_privilege('authenticated','content.max_exports','UPDATE') as update,
    has_any_column_privilege('authenticated','content.max_exports','SELECT') as read,
    has_function_privilege('authenticated','research.max_write_worker_session(jsonb,uuid,boolean,uuid,text,bigint)','EXECUTE') as write,
    has_function_privilege('anon','research.max_consume_rate_limit(text,integer,integer)','EXECUTE') as rate`)
  ).rows[0];
  assert.deepEqual(privileges, {
    insert: false,
    update: false,
    read: true,
    write: false,
    rate: false,
  });
  checks++;
  await db.exec(readFileSync(resolve("supabase/tests/exports_security.sql"), "utf8"));
  checks++;
  console.log(
    `PostgreSQL backend integrity: ${checks} checks passed; all non-vector migrations applied locally.`,
  );
} finally {
  await db.close();
}
