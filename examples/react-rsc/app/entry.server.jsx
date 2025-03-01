/// <reference types="react/experimental" />
import { use } from "react";
import { renderToPipeableStream as renderToPipeableStreamDOM } from "react-dom/server";
import { createFromNodeStream } from "react-server-dom-webpack/client";
import { renderToPipeableStream as renderToPipeableStreamRSC } from "react-server-dom-webpack/server";
import { matchTrie } from "router-trie";

import entryScript from "jbundler/client-entry";
import webpackMapJson from "jbundler/webpack-map";

import { MatchRenderer } from "./components/router.jsx";
import Html from "./html.jsx";
import routes from "./routes.jsx";
import { PassThrough } from "node:stream";

const RENDER_TIMEOUT = 5_000;

const webpackMap = JSON.parse(webpackMapJson);

/**
 * @param {{
 *  res: import("node:http").ServerResponse<import("node:http").IncomingMessage>;
 *  url: URL;
 * }} args
 */
export default async function handler({ res, url }) {
  const matches = matchTrie(routes, url.pathname);

  if (!matches) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const matchPreparationPromises = [];
  for (const match of matches) {
    matchPreparationPromises.push(prepareMatch(match, url));
  }
  await Promise.all(matchPreparationPromises);

  const rscStream = renderToPipeableStreamRSC(
    <MatchRenderer matches={matches} />,
    webpackMap,
    {
      onError(error) {
        console.error(error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal server error");
        }
      },
    }
  );

  if (url.searchParams.has("_rsc")) {
    rscStream.pipe(res);
    setTimeout(() => {
      rscStream.abort();
    }, RENDER_TIMEOUT);
  } else {
    const rscPassthrough = new PassThrough();
    const rscChunk = createFromNodeStream(rscPassthrough, webpackMap);
    const rscJSONPromise = new Promise((resolve, reject) => {
      const buffer = [];
      rscPassthrough.on("data", (chunk) => {
        buffer.push(chunk);
      });
      rscPassthrough.on("end", () => {
        const rsc = Buffer.concat(buffer).toString();
        resolve(rsc);
      });
      rscPassthrough.on("error", (error) => {
        reject(error);
      });
    });
    rscStream.pipe(rscPassthrough);
    function ReactServerComponent() {
      return use(rscChunk);
    }
    function Scripts() {
      const rsc = use(rscJSONPromise);
      return (
        <>
          <script type="text/rsc" dangerouslySetInnerHTML={{ __html: rsc }} />
          <script async type="module" src={entryScript} />
        </>
      );
    }
    const domStream = renderToPipeableStreamDOM(
      <Html scripts={<Scripts />}>
        <ReactServerComponent />
      </Html>,
      {
        onShellReady() {
          res.writeHead(200, { "Content-Type": "text/html" });
          domStream.pipe(res);
        },
        onShellError(error) {
          console.error(error);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal server error");
          }
        },
        onError(error) {
          console.error(error);
        },
      }
    );
    setTimeout(() => {
      rscStream.abort();
      domStream.abort();
    }, RENDER_TIMEOUT);
  }

  // if (!url.searchParams.has("_rsc")) {
  //   const html = renderToString(<Html />);
  //   res.writeHead(200, { "Content-Type": "text/html" });
  //   res.end("<!DOCTYPE html>" + html);
  //   return;
  // }
}

async function prepareMatch(match, url) {
  if (match.loader) {
    try {
      match.data = await match.loader({ url });
    } catch (error) {
      match.error = error || null;
    }
  }
}
