/*
 * SQLite 3.54.x：每次执行前调用 sqlite3_clear_bindings() 时，带 JOIN 的语句每次都被重新编译。
 * node:sqlite（Node 26.12 内置 SQLite 3.54.0）每次执行都是 reset → clear_bindings → bind → step，所以会触发。
 *
 *   gcc -O2 -I <amalgamation 目录> sqlite-3.54-clear-bindings.c <amalgamation 目录>/sqlite3.c -lpthread -ldl -lm && ./a.out
 *
 * 本机（linux-arm64）结果：
 *   3.53.4  join 0.69us reprepare=0
 *   3.54.1  join 5.47us reprepare=200000
 *   3.54.1 去掉 clear_bindings 后：join 0.64us reprepare=8
 *   3.54.1 + check-in 535a77cf5a（上游修复）：join 0.65us reprepare=8
 */
#include <stdio.h>
#include <time.h>
#include "sqlite3.h"

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e6 + t.tv_nsec / 1e3;
}

int main(void) {
  sqlite3 *db;
  sqlite3_stmt *s;
  sqlite3_open(":memory:", &db);
  sqlite3_exec(db, "create table t (id integer primary key, h text not null);"
                   "create table p (id integer primary key, a integer); begin;", 0, 0, 0);
  sqlite3_prepare_v2(db, "insert into t values (?, 'x')", -1, &s, 0);
  for (int i = 1; i <= 100000; i++) { sqlite3_bind_int(s, 1, i); sqlite3_step(s); sqlite3_reset(s); }
  sqlite3_finalize(s);
  sqlite3_prepare_v2(db, "insert into p values (?, ?)", -1, &s, 0);
  for (int i = 1; i <= 60000; i++) { sqlite3_bind_int(s, 1, i); sqlite3_bind_int(s, 2, 1 + (i * 7) % 100000); sqlite3_step(s); sqlite3_reset(s); }
  sqlite3_finalize(s);
  sqlite3_exec(db, "commit", 0, 0, 0);

  const char *qs[] = {"select h from t where id = ?", "select t.h from p join t on t.id = p.a where p.id = ?"};
  for (int k = 0; k < 2; k++) {
    sqlite3_prepare_v2(db, qs[k], -1, &s, 0);
    double t0 = now();
    for (int i = 0; i < 200000; i++) {
      sqlite3_reset(s);
      sqlite3_clear_bindings(s);
      sqlite3_bind_int(s, 1, 1 + i % 60000);
      sqlite3_step(s);
      sqlite3_reset(s);
    }
    printf("%s  %-55s %.2fus reprepare=%d\n", sqlite3_libversion(), qs[k], (now() - t0) / 200000,
           sqlite3_stmt_status(s, SQLITE_STMTSTATUS_REPREPARE, 0));
    sqlite3_finalize(s);
  }
  return 0;
}
