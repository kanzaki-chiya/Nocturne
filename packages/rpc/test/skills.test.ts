import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPlatform, loadConfig } from "@nocturne/core";
import { cleanupTmp, connectWithConfig, MODEL, tmpDir } from "./harness.js";

afterEach(cleanupTmp);
it("技能扫描、会话快照、submit、启停通知及参数校验经 RPC 往返", async () => {
  const home = tmpDir("nct-rpc-skills-");
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const h = await connectWithConfig({
    config: await loadConfig(createPlatform(), { nocturneHome: home }),
  });
  try {
    const dir = path.join(h.config.nocturneHome, "skills/alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "---\ndescription: RPC skill\n---\nbody $ARGUMENTS");
    const description = await h.client.runtime.describeSkills();
    expect(description.skills[0]).not.toHaveProperty("body");
    expect(description.skills.find((s) => s.name === "alpha")).toMatchObject({
      source: ".nocturne",
      realPath: await createPlatform().fs.realpath(dir),
    });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    expect((await session.describeSkills()).skills.find((s) => s.name === "alpha")?.enabled).toBe(
      true,
    );
    await session.submit({ text: "/alpha test", skill: { name: "alpha", arguments: "test" } });
    expect(h.durable(session.id).find((e) => e.type === "message.user")?.payload).toMatchObject({
      skill: { name: "alpha", body: "body test" },
    });
    let notified = false;
    const off = h.client.onProvidersChanged(() => {
      notified = true;
    });
    expect(await h.client.runtime.setSkillEnabled({ name: "alpha", enabled: false })).toEqual({
      affectedSessions: 1,
    });
    expect(notified).toBe(true);
    off();
    expect((await session.describeSkills()).skills.find((s) => s.name === "alpha")?.enabled).toBe(
      false,
    );
    await expect(
      h.client.call("skills.setSkillEnabled", { name: "alpha", enabled: "yes" as never }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      h.client.call("session.submit", {
        sessionId: session.id,
        text: "bad",
        skill: { name: 12 as never },
      }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await session.close();
  } finally {
    await h.client.shutdown();
    await h.served;
  }
});
