import { randomBytes } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Database } from "bun:sqlite";
import cron from "node-cron";
import parseArgs from "minimist";

const help = `Usage:
./ntfy-node [options]

Options:
--port, -p  Port to listen on (default: 8080)
--sqlite, -s SQLite database file (default: ./ntfy.sqlite)
--help, -h  Show this help message
`;

const { port: portRaw, sqlite: sqliteRaw, help: helpRaw } = parseArgs(process.argv.slice(2));

if (helpRaw) {
    console.log(help);
    process.exit(0);
}

const port = parseInt(portRaw, 10) || 8080;
const sqlite = sqliteRaw || "./ntfy.sqlite";
const timeout = 12 * 3600;

if (port <= 1024) {
    console.log("port must be greater than 1024");
    process.exit(1);
}

const base = "example.com";

const tutorial = `Bad Request
Follow the tutorial below:

Publish:
    curl -d {content} "http://${base}/{topic}"
Subscription:
    websocat wss://${base}/{topic}/ws
Pull messages:
    curl "http://${base}/{topic}/json"                     # default all
    curl "http://${base}/{topic}/json?since=1763217840"    # since timestamp
    curl "http://${base}/{topic}/json?since=uP4ID5x0fkQh"  # since message id
Auth: # only for ntfy app
    curl "http://${base}/auth" -> \`{ "success": true }\`
Message Priority:
    Visit http://docs.ntfy.sh/publish/#message-priority
	Support HTTP Header \`X-Priority\` with value \`1-5\` only
Cache and Expires:
    cache messages for 12h and remove every 1h

Docs: https://docs.ntfy.sh/subscribe/api/
Only support partial features.
`;

const topic_regex = /^[A-Za-z0-9\-_]+$/;

const server = createServer();

server.on("request", async (request, response) => {
    if (!request.url) return response.writeHead(400, { "Content-Type": "text/plain" }).end("Error");

    const [_, topic_string] = new URL(request.url, "http://example.com").pathname.split("/");
    const topics = topic_string?.split(",");
    if (!topics || !topics.length || !topics.every((topic) => topic_regex.test(topic))) {
        return response.writeHead(400, { "Content-Type": "text/plain" }).end(tutorial);
    }

    return await _fetch(request, response);
});

server.on("upgrade", function upgrade(request, socket, head) {
    if (!request.url) return socket.destroy();

    const [_, topic_string, command] = new URL(request.url, "http://example.com").pathname.split("/");

    switch (true) {
        case command === "ws": {
            wss.handleUpgrade(request, socket, head, function done(ws) {
                wss.emit("connection", ws, request);
            });
            return;
        }
    }

    socket.destroy();
});

server.listen(port, () => console.log("Server is running on port " + port));

const _sockets = new Map<string, Set<WebSocket>>();

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (client, request) => {
    if (!request.url) return client.close();

    const [_, topic_string, command] = new URL(request.url, "http://example.com").pathname.split("/");
    const topics = topic_string?.split(",");
    if (!topics || !topics.length || !topics.every((topic) => topic_regex.test(topic))) {
        return client.close();
    }

    topics.forEach((topic) => {
        if (!_sockets.get(topic)) _sockets.set(topic, new Set());
        _sockets.get(topic)!.add(client);
    });

    client.send(
        JSON.stringify({
            id: getRandomId(),
            time: Math.floor(Date.now() / 1000),
            event: "open",
            topic: topics.join(","),
        })
    );

    client.addEventListener("close", () => {
        _close(client);
        client.close();
    });

    client.addEventListener("error", (error) => {
        console.error("WebSocket error:", error);
        _close(client);
    });
});

const db = new Database(sqlite);

const _fetch = async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url) return response.writeHead(400, { "Content-Type": "text/plain" }).end("Error");

    const params = new URL(request.url, "http://example.com").searchParams;
    const [_, topic_string, command] = new URL(request.url, "http://example.com").pathname.split("/");
    const topics = topic_string?.split(",");
    if (!topics || !topics.length || !topics.every((topic) => topic_regex.test(topic))) {
        return response.writeHead(400, { "Content-Type": "text/plain" }).end(tutorial);
    }

    switch (true) {
        case request.method === "GET" && command === "auth": {
            return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true }));
        }
        case request.method === "GET" && command === "json": {
            const items = _query(topics[0]!, params.get("since"));

            return response
                .writeHead(200, {
                    "Content-Type": "application/x-ndjson; charset=utf-8",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache",
                })
                .end(
                    items.map(({ priority, ...item }) => JSON.stringify({ ...item, ...(priority === 3 ? {} : { priority }), event: "message" })).join("\n") +
                        "\n"
                );
        }
        case (request.method === "POST" || request.method === "PUT") && !command: {
            const content = await new Promise<string>((resolve, reject) => {
                let text = "";
                request.on("error", reject);
                request.on("data", (chunk) => (text += chunk.toString()));
                request.on("end", () => resolve(text));
            });
            const priority = parseInt(
                (Array.isArray(request.headers["x-priority"]) ? request.headers["x-priority"][0] : request.headers["x-priority"]) || "3",
                10
            );
            if (priority < 1 || priority > 5)
                return response
                    .writeHead(400, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    })
                    .end(
                        JSON.stringify({
                            code: 40007,
                            http: 400,
                            error: "invalid priority parameter",
                            link: "https://ntfy.sh/docs/publish/#message-priority",
                        }) + "\n"
                    );
            const broadcastResponse = _broadcast(response, topics[0]!, priority, content || "triggered");
            return broadcastResponse;
        }
    }
    return response.writeHead(400, { "Content-Type": "text/plain" }).end(tutorial);
};

const _close = (server: WebSocket) => {
    _sockets.forEach((sockets_set, topic, map) => {
        sockets_set.delete(server);
        if (!sockets_set.size) map.delete(topic);
    });
};

const _broadcast = (response: ServerResponse, topic: string, priority: number, content: string) => {
    const time = Math.floor(Date.now() / 1000);

    const id = getRandomId();

    const item = {
        id,
        time,
        expires: time + timeout,
        event: "message",
        topic,
        message: content,
        priority,
    };
    _save(item);

    _sockets.get(topic)?.forEach((server) => {
        server.send(
            JSON.stringify({
                id,
                time,
                expires: time + timeout,
                event: "message",
                topic,
                message: content,
                ...(priority === 3 ? {} : { priority }),
            }) + "\n"
        );
    });

    return response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
            id,
            time,
            expires: time + timeout,
            event: "message",
            topic,
            message: content,
            ...(priority === 3 ? {} : { priority }),
        }) + "\n"
    );
};

const _save = ({ id, time, expires, topic, priority, message }: Item) => {
    db.query(
        `
		CREATE TABLE IF NOT EXISTS "messages" (
			"id"		TEXT NOT NULL UNIQUE,
			"time"		INTEGER NOT NULL,
			"expires"	INTEGER NOT NULL,
			"topic"		TEXT NOT NULL,
			"priority"	INTEGER NOT NULL,
			"message"	TEXT,
			PRIMARY KEY("id", "topic")
		);
		`
    ).run();

    db.query(
        `
		INSERT INTO "messages" ("id", "time", "expires", "topic", "message", "priority") VALUES
			(?, ?, ?, ?, ?, ?);
		`
    ).all(id, time, expires, topic, message, priority);
};

const _query = (topic: string, since: string | null = "") => {
    const duration_regex = /^(\d+)([smhd])$/;
    switch (true) {
        case !since: {
            return db
                .query(
                    `
					SELECT "id", "time", "expires", "topic", "message", "priority" FROM "messages"
						WHERE "topic" = ?;
					`
                )
                .all(topic) as Item[];
        }
        case since === "all": {
            // `since` all
            return db
                .query(
                    `
					SELECT "id", "time", "expires", "topic", "message", "priority" FROM "messages"
						WHERE "topic" = ?;
					`
                )
                .all(topic) as Item[];
        }
        case since?.length === 10: {
            // `since` is timestamp(seconds)
            return db
                .query(
                    `
					SELECT "id", "time", "expires", "topic", "message", "priority" FROM "messages"
						WHERE "topic" = ? AND "time" >= ?;
					`
                )
                .all(topic, since) as Item[];
        }
        case since?.length === 12: {
            // `since` is messgae id
            return db
                .query(
                    `
					SELECT "id", "time", "expires", "topic", "message", "priority" FROM "messages"
						WHERE "topic" = ?
						AND time >= (SELECT "time" FROM "messages" WHERE "id" = ?);
					`
                )
                .all(topic, since) as Item[];
        }
        case duration_regex.test(since || ""): {
            const [_, num, unit] = since!.match(duration_regex)!;
            let timestamp = Math.floor(Date.now() / 1000);
            switch (unit) {
                case "s":
                case "S": {
                    timestamp -= parseInt(num!) * 1;
                    break;
                }
                case "m":
                case "M": {
                    timestamp -= parseInt(num!) * 60;
                    break;
                }
                case "h":
                case "H": {
                    timestamp -= parseInt(num!) * 3600;
                    break;
                }
                case "d":
                case "D": {
                    timestamp -= parseInt(num!) * 3600 * 24;
                    break;
                }
            }
            return db
                .query(
                    `
					SELECT "id", "time", "expires", "topic", "message", "priority" FROM "messages"
						WHERE "topic" = ? AND time >= ?;
					`
                )
                .all(topic, timestamp) as Item[];
        }
    }

    return [];
};

const _remove_expired = () => {
    const now = Math.floor(Date.now() / 1000);
    db.query(
        `
		DELETE FROM "messages" WHERE "expires" < ?;
		`
    ).run(now);
};

_remove_expired();

cron.schedule("58 * * * *", () => {
    _remove_expired();
});

const getRandomId = (length = 12) =>
    randomBytes(length)
        .reduce((result, byte) => result + "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[byte % 62], "")
        .slice(0, length);

type Item = { id: string; time: number; expires: number; topic: string; priority: number; message: string };
