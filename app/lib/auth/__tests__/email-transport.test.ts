import { once } from "node:events";
import { type AddressInfo, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSmtpTransport } from "~/lib/auth/email-transport.server";

function startPlaintextSmtpServer(commands: string[]): Server {
  return createServer((socket) => {
    let buffer = "";
    let inData = false;
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        commands.push(line);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        const verb = line.split(" ")[0]?.toUpperCase();
        if (verb === "EHLO") {
          socket.write("250-test\r\n250 AUTH PLAIN LOGIN\r\n");
        } else if (verb === "STARTTLS") {
          socket.write("502 5.5.1 STARTTLS not available\r\n");
        } else if (verb === "AUTH") {
          socket.write("235 2.7.0 accepted\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });
}

describe("createSmtpTransport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      server.close();
      await once(server, "close");
      server = undefined;
    }
  });

  it("refuses to authenticate or send over plaintext when STARTTLS is unavailable", async () => {
    const commands: string[] = [];
    server = startPlaintextSmtpServer(commands);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const send = createSmtpTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      user: "mailer",
      password: "secret",
      from: "noreply@example.com",
    });

    await expect(
      send({
        to: "user@example.com",
        subject: "Reset your S2 password",
        text: "http://localhost:8888/api/auth/reset-password/abc",
        html: "<p>reset</p>",
      }),
    ).rejects.toThrow(/STARTTLS/);

    const verbs = commands.map((line) => line.split(" ")[0]?.toUpperCase());
    expect(verbs).toContain("STARTTLS");
    expect(verbs).not.toContain("AUTH");
    expect(verbs).not.toContain("MAIL");
    expect(verbs).not.toContain("DATA");
  });
});
