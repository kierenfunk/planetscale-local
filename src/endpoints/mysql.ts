import { type Request, type Response } from "express";
import {
  type PoolConnection,
  type RowDataPacket,
  createPool,
} from "mysql2/promise";
import { randomUUID } from "node:crypto";

import { MYSQL_URL } from "../env";

const connectionUrl = new URL(MYSQL_URL);

const pool = createPool({
  host: connectionUrl.hostname,
  port: parseInt(connectionUrl.port, 10),
  user: connectionUrl.username,
  password: connectionUrl.password,
  database: connectionUrl.pathname.slice(1),
	nestTables: true,
});

const connections = new Map<string, PoolConnection>();
const connectionTimeouts = new Map<string, NodeJS.Timer>();

export interface Field {
  name: string;
  type: string;
  table: string;

  // Only populated for included fields
  database?: string | null;
  orgTable?: string | null;
  orgName?: string | null;

  columnLength?: number | null;
  charset?: number | null;
  flags?: number | null;
  columnType?: string | null;
}

interface QueryResultRow {
  lengths: string[];
  values?: string;
}

interface QueryResult {
  rowsAffected?: string | null;
  insertId?: string | null;
  fields?: Field[] | null;
  rows?: QueryResultRow[];
}

interface VitessError {
  message: string;
  code: string;
}

interface QueryExecuteResponse {
  session: string;
  result: QueryResult | null;
  error?: VitessError;
  timing?: number;
}

function typeIdToLabel(id: number){
	switch(id){
		case 245:
			return "JSON";
		default:
			return `${id}`
	}
}

function getFieldValue(singleRow: RowDataPacket, field: Field){
	let fieldValue = singleRow[field.table][field.name];
	if (typeof fieldValue === "object" && fieldValue !== null) {
		fieldValue = JSON.stringify(fieldValue);
	}
	if (field === null) {
		return [fieldValue, "0"]
	}
	else if (fieldValue === null){
		return [null, "-1"]
	}
	return [fieldValue, `${fieldValue}`.length]
}

export async function executeQuery(
  req: Request,
  res: Response<QueryExecuteResponse>,
) {
  const { body } = req;
  const { query, session = randomUUID() } = body as {
    query: string;
    session: string;
  };

  console.log(query, session);

  try {
    const connection = connections.has(session)
      ? (connections.get(session) as PoolConnection)
      : await pool.getConnection();
    const [rows, fields] = await connection.query(query);

    const result: QueryResult = {
      fields: fields?.map((field) => ({
        name: field.name,
        type: typeIdToLabel(field.type),
        table: field.table,
        database: field.db,
        orgTable: field.orgTable,
        orgName: field.orgName,
        columnLength: field.length,
        charset: field.charsetNr,
        flags: field.flags,
        columnType: null,
      })),
    };

    if (Array.isArray(rows)) {
			rows.map((row) => {
        result.rows = result.rows || [];
				const lengths: string[] = [];
				let rawValue = "";
				for (const field  of result.fields as Field[]) {
					if (typeof field === "undefined") continue;
					if (Array.isArray(row)){
						row.map((singleRow) =>{
							const [value, length] = getFieldValue(singleRow, field);
							lengths.push(length);
							rawValue += value;
						})
					} else if (typeof row.procotol41 === "undefined") {
						const [value, length] = getFieldValue(row as RowDataPacket, field);
						lengths.push(length);
						rawValue += value;
					}
				}
				result.rows?.push({
					lengths,
					values: Buffer.from(rawValue).toString("base64"),
				});
			});
    } else {
      result.rowsAffected = `${rows.affectedRows}`;
      result.insertId = `${rows.insertId}`;
    }

    connections.set(session, connection);

    const timeout = connectionTimeouts.get(session);

    if (timeout) {
      clearTimeout(timeout);
    }

    connectionTimeouts.set(
      session,
      setTimeout(() => {
        connection.release();
      }, 30_000),
    );

    return res.json({ result, session });
  } catch (_) {
    console.error(_);

    return res.status(500).json({
      error: {
        // rome-ignore lint/suspicious/noExplicitAny: Custom Error logic here
        code: (_ as any).code || "UNKNOWN_CODE",
        message: (_ as Error).message,
      },
      session,
      result: null,
    });
  }
}

export async function createSession(_req: Request, res: Response) {
  const sessionId = randomUUID();
  const connection = await pool.getConnection();

  connections.set(sessionId, connection);
  connectionTimeouts.set(
    sessionId,
    setTimeout(() => {
      connection.release();
    }, 30_000),
  );

  return res.json({ session: sessionId });
}
