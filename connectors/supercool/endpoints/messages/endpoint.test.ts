import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Json } from "@shared/core";
import { loadFixture, runEndpoint, testSealedUnit } from "@shared/testing";

const ID = "supercool#v1/messages";
const fixturesDir = fromFileUrl(new URL("./fixtures/", import.meta.url));
const INPUT = { body: { message: "A product photo of a ceramic coffee mug" } };

const run = async (name: string) =>
    await runEndpoint({
        unit: await testSealedUnit(ID),
        input: INPUT,
        mode: "replay",
        fixture: await loadFixture(`${fixturesDir}${name}.json`),
    });

Deno.test("supercool: processing work long-polls to completed and settles the receipt exactly", async () => {
    const result = await run("synthetic-work-completed");
    assertEquals(result.httpStatus, 200);
    assertEquals(result.isProviderError, false);
    // claim 12.5 credits = fold 1250 hundredths × 0.01
    assertEquals(result.usage, {
        credits: { default: 12.5 },
        evidence: { CREDIT: 1250 },
    });
    const output = result.output as Record<string, unknown>;
    assertEquals(output.status, "completed");
    assertEquals(output.credits_used, undefined); // the receipt is plucked
    const files = output.files as Array<{ name: string }>;
    assertEquals(files[0].name, "mug.png");
});

Deno.test("supercool: a plain reply settles on the submit without polling, and bills nothing", async () => {
    const result = await run("synthetic-reply-on-submit");
    assertEquals(result.httpStatus, 200);
    assertEquals(result.isProviderError, false);
    assertEquals(result.usage.credits, {});
    assertEquals(
        (result.output as { reply: string }).reply.startsWith("Yes"),
        true,
    );
});

Deno.test("supercool: an account out of credits is a 402 with zero usage", async () => {
    const result = await run("synthetic-out-of-credits");
    assertEquals(result.httpStatus, 402);
    assertEquals(result.providerHttpStatus, 201);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, { credits: {}, evidence: {} });
});

Deno.test("supercool: a rejected key is data, not a poll", async () => {
    const result = await run("synthetic-unauthorized");
    assertEquals(result.httpStatus, 401);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, { credits: {}, evidence: {} });
});

Deno.test("supercool: a failed status read holds the run instead of ending it", async () => {
    const result = await run("synthetic-status-read-retry");
    assertEquals(result.httpStatus, 200);
    assertEquals(result.usage.credits, { default: 12.5 });
});

Deno.test("supercool: work that fails after starting is a 502 with zero usage", async () => {
    const result = await run("synthetic-work-failed");
    assertEquals(result.httpStatus, 502);
    assertEquals(result.providerHttpStatus, 200);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, { credits: {}, evidence: {} });
});

Deno.test("supercool: the input schema rejects before the wire", async () => {
    const unit = await testSealedUnit(ID);
    const rejects = async (body: Json, why: string) => {
        await assertRejects(
            () => runEndpoint({ unit, input: { body }, mode: "replay" }),
            Error,
            "INVALID_INPUT",
            why,
        );
    };
    await rejects({ message: "" }, "empty message");
    await rejects({ message: "a".repeat(20_001) }, "message over 20,000");
    await rejects({ message: "hi", extra: true }, "unknown field");
    await rejects(
        { message: "hi", files: [{ url: "not a url" }] },
        "file without a URL",
    );
    await rejects(
        {
            message: "hi",
            files: Array.from({ length: 6 }, (_, i) => ({
                url: `https://example.com/${i}.png`,
            })),
        },
        "more than 5 files",
    );
});
