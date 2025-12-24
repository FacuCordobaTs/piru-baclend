import * as jwt from "jsonwebtoken";

export async function createAccessToken(payload: any) {
  return new Promise((resolve, reject) => {
    jwt.sign(payload, process.env.JWT_SECRET || 'fallback-secret', { expiresIn: "1d" }, (err, token) => {
      if (err) reject(err);
      resolve(token);
    });
  });
}