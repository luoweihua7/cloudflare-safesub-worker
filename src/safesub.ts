
// require('js-yaml')

// src/index.js
init_modules_watch_stub();
var yaml = require_js_yaml();
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.origin;
    const frontendUrl = 'https://raw.githubusercontent.com/bulianglin/psub/main/frontend.html';
    const SUB_BUCKET = env.SUB_BUCKET;
    let backend = env.BACKEND.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const subDir = "subscription";
    const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (pathSegments.length === 0) {
      const response = await fetch(frontendUrl);
      if (response.status !== 200) {
        return new Response('Failed to fetch frontend', { status: response.status });
      }
      const originalHtml = await response.text();
      const modifiedHtml = originalHtml.replace(/https:\/\/bulianglin2023\.dev/, host);
      return new Response(modifiedHtml, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
        },
      });
    } else if (pathSegments[0] === subDir) {
      const key = pathSegments[pathSegments.length - 1];
      const object = await SUB_BUCKET.get(key);
      const object_headers = await SUB_BUCKET.get(key + "_headers");
      if (object === null)
        return new Response("Not Found", { status: 404 });
      if ("R2Bucket" === SUB_BUCKET.constructor.name) {
        const headers = object_headers ? new Headers(await object_headers.json()) : new Headers({ "Content-Type": "text/plain;charset=UTF-8" });
        return new Response(object.body, { headers });
      } else {
        const headers = object_headers ? new Headers(JSON.parse(object_headers)) : new Headers({ "Content-Type": "text/plain;charset=UTF-8" });
        return new Response(object, { headers });
      }
    }

    const urlParam = url.searchParams.get("url");
    if (!urlParam)
      return new Response("Missing URL parameter", { status: 400 });
    const backendParam = url.searchParams.get("bd");
    if (backendParam && /^(https?:\/\/[^/]+)[.].+$/g.test(backendParam))
      backend = backendParam.replace(/(https?:\/\/[^/]+).*$/, "$1");
    const replacements = {};
    const replacedURIs = [];
    const keys = [];
    if (urlParam.startsWith("proxies:")) {
      const { format, data } = parseData(urlParam.replace(/\|/g, "\r\n"));
      if ("yaml" === format) {
        const key = generateRandomStr(11);
        const replacedYAMLData = replaceYAML(data, replacements);
        if (replacedYAMLData) {
          await SUB_BUCKET.put(key, replacedYAMLData);
          keys.push(key);
          replacedURIs.push(`${host}/${subDir}/${key}`);
        }
      }
    } else {
      const urlParts = urlParam.split("|").filter((part) => part.trim() !== "");
      if (urlParts.length === 0)
        return new Response("There are no valid links", { status: 400 });
      let response, parsedObj;
      for (const url2 of urlParts) {
        const key = generateRandomStr(11);
        if (url2.startsWith("https://") || url2.startsWith("http://")) {
          response = await fetch(url2, {
            method: request.method,
            headers: request.headers,
            redirect: 'follow', // https://developers.cloudflare.com/workers/runtime-apis/request#constructor
          });
          if (!response.ok)
            continue;
          const plaintextData = await response.text();
          parsedObj = parseData(plaintextData);
          await SUB_BUCKET.put(key + "_headers", JSON.stringify(Object.fromEntries(response.headers)));
          keys.push(key);
        } else {
          parsedObj = parseData(url2);
        }
        if (/^(ssr?|vmess1?|trojan|vless|hysteria):\/\//.test(url2)) {
          const newLink = replaceInUri(url2, replacements, false);
          if (newLink)
            replacedURIs.push(newLink);
          continue;
        } else if ("base64" === parsedObj.format) {
          const links = parsedObj.data.split(/\r?\n/).filter((link) => link.trim() !== "");
          const newLinks = [];
          for (const link of links) {
            const newLink = replaceInUri(link, replacements, false);
            if (newLink)
              newLinks.push(newLink);
          }
          const replacedBase64Data = btoa(newLinks.join("\r\n"));
          if (replacedBase64Data) {
            await SUB_BUCKET.put(key, replacedBase64Data);
            keys.push(key);
            replacedURIs.push(`${host}/${subDir}/${key}`);
          }
        } else if ("yaml" === parsedObj.format) {
          const replacedYAMLData = replaceYAML(parsedObj.data, replacements);
          if (replacedYAMLData) {
            await SUB_BUCKET.put(key, replacedYAMLData);
            keys.push(key);
            replacedURIs.push(`${host}/${subDir}/${key}`);
          }
        }
      }
    }
    const newUrl = replacedURIs.join("|");
    url.searchParams.set("url", newUrl);
    const modifiedRequest = new Request(backend + url.pathname + url.search, request);
    const rpResponse = await fetch(modifiedRequest);
    for (const key of keys) {
      await SUB_BUCKET.delete(key);
    }
    if (rpResponse.status === 200) {
      const plaintextData = await rpResponse.text();
      try {
        const decodedData = urlSafeBase64Decode(plaintextData);
        const links = decodedData.split(/\r?\n/).filter((link) => link.trim() !== "");
        const newLinks = [];
        for (const link of links) {
          const newLink = replaceInUri(link, replacements, true);
          if (newLink)
            newLinks.push(newLink);
        }
        const replacedBase64Data = btoa(newLinks.join("\r\n"));
        return new Response(replacedBase64Data, rpResponse);
      } catch (base64Error) {
        const result = plaintextData.replace(
          new RegExp(Object.keys(replacements).join("|"), "g"),
          (match) => replacements[match] || match
        );
        return new Response(result, rpResponse);
      }
    }
    return rpResponse;
  }
};
function replaceInUri(link, replacements, isRecovery) {
  switch (true) {
    case link.startsWith("ss://"):
      return replaceSS(link, replacements, isRecovery);
    case link.startsWith("ssr://"):
      return replaceSSR(link, replacements, isRecovery);
    case link.startsWith("vmess://"):
    case link.startsWith("vmess1://"):
      return replaceVmess(link, replacements, isRecovery);
    case link.startsWith("trojan://"):
    case link.startsWith("vless://"):
      return replaceTrojan(link, replacements, isRecovery);
    case link.startsWith("hysteria://"):
      return replaceHysteria(link, replacements);
    default:
      return;
  }
}
function replaceSSR(link, replacements, isRecovery) {
  link = link.slice("ssr://".length).replace("\r", "").split("#")[0];
  link = urlSafeBase64Decode(link);
  const regexMatch = link.match(/(\S+):(\d+?):(\S+?):(\S+?):(\S+?):(\S+)\//);
  if (!regexMatch) {
    return;
  }
  const [, server, , , , , password] = regexMatch;
  let replacedString;
  if (isRecovery) {
    replacedString = "ssr://" + urlSafeBase64Encode(link.replace(password, urlSafeBase64Encode(replacements[urlSafeBase64Decode(password)])).replace(server, replacements[server]));
  } else {
    const randomPassword = generateRandomStr(12);
    const randomDomain = generateRandomStr(12) + ".com";
    replacements[randomDomain] = server;
    replacements[randomPassword] = urlSafeBase64Decode(password);
    replacedString = "ssr://" + urlSafeBase64Encode(link.replace(server, randomDomain).replace(password, urlSafeBase64Encode(randomPassword)));
  }
  return replacedString;
}
function replaceVmess(link, replacements, isRecovery) {
  const randomUUID = generateRandomUUID();
  const randomDomain = generateRandomStr(10) + ".com";
  const regexMatchRocketStyle = link.match(/vmess:\/\/([A-Za-z0-9-_]+)\?(.*)/);
  if (regexMatchRocketStyle) {
    const base64Data = regexMatchRocketStyle[1];
    const regexMatch = urlSafeBase64Decode(base64Data).match(/(.*?):(.*?)@(.*):(.*)/);
    if (!regexMatch)
      return;
    const [, cipher, uuid, server, port] = regexMatch;
    replacements[randomDomain] = server;
    replacements[randomUUID] = uuid;
    const newStr = urlSafeBase64Encode(`${cipher}:${randomUUID}@${randomDomain}:${port}`);
    const result = link.replace(base64Data, newStr);
    return result;
  }
  const regexMatchKitsunebiStyle = link.match(/vmess1:\/\/(.*?)@(.*):(.*?)\?(.*)/);
  if (regexMatchKitsunebiStyle) {
    const [, uuid, server] = regexMatchKitsunebiStyle;
    replacements[randomDomain] = server;
    replacements[randomUUID] = uuid;
    const regex = new RegExp(`${uuid}|${server}`, "g");
    const result = link.replace(regex, (match) => cReplace(match, uuid, randomUUID, server, randomDomain));
    return result;
  }
  let tempLink = link.replace(/vmess:\/\/|vmess1:\/\//g, "");
  try {
    tempLink = urlSafeBase64Decode(tempLink);
    const regexMatchQuanStyle = tempLink.match(/(.*?) = (.*)/);
    if (regexMatchQuanStyle) {
      const configs = regexMatchQuanStyle[2].split(",");
      if (configs.length < 6)
        return;
      const server2 = configs[1].trim();
      const uuid2 = configs[4].trim().replace(/^"|"$/g, "");
      replacements[randomDomain] = server2;
      replacements[randomUUID] = uuid2;
      const regex2 = new RegExp(`${uuid2}|${server2}`, "g");
      const result2 = tempLink.replace(regex2, (match) => cReplace(match, uuid2, randomUUID, server2, randomDomain));
      return "vmess://" + btoa(result2);
    }
    const jsonData = JSON.parse(tempLink);
    const server = jsonData.add;
    const uuid = jsonData.id;
    const regex = new RegExp(`${uuid}|${server}`, "g");
    let result;
    if (isRecovery) {
      result = tempLink.replace(regex, (match) => cReplace(match, uuid, replacements[uuid], server, replacements[server]));
    } else {
      replacements[randomDomain] = server;
      replacements[randomUUID] = uuid;
      result = tempLink.replace(regex, (match) => cReplace(match, uuid, randomUUID, server, randomDomain));
    }
    return "vmess://" + btoa(result);
  } catch (error) {
    return;
  }
}
function replaceSS(link, replacements, isRecovery) {
  const randomPassword = generateRandomStr(12);
  const randomDomain = randomPassword + ".com";
  let replacedString;
  let tempLink = link.slice("ss://".length).split("#")[0];
  if (tempLink.includes("@")) {
    const regexMatch1 = tempLink.match(/(\S+?)@(\S+):/);
    if (!regexMatch1) {
      return;
    }
    const [, base64Data, server] = regexMatch1;
    const regexMatch2 = urlSafeBase64Decode(base64Data).match(/(\S+?):(\S+)/);
    if (!regexMatch2) {
      return;
    }
    const [, encryption, password] = regexMatch2;
    if (isRecovery) {
      const newStr = urlSafeBase64Encode(encryption + ":" + replacements[password]);
      replacedString = link.replace(base64Data, newStr).replace(server, replacements[server]);
    } else {
      replacements[randomDomain] = server;
      replacements[randomPassword] = password;
      const newStr = urlSafeBase64Encode(encryption + ":" + randomPassword);
      replacedString = link.replace(base64Data, newStr).replace(/@.*:/, `@${randomDomain}:`);
    }
  } else {
    try {
      const decodedValue = urlSafeBase64Decode(tempLink);
      const regexMatch = decodedValue.match(/(\S+?):(\S+)@(\S+):/);
      if (!regexMatch) {
        return;
      }
      const [, , password, server] = regexMatch;
      replacements[randomDomain] = server;
      replacements[randomPassword] = password;
      replacedString = "ss://" + urlSafeBase64Encode(decodedValue.replace(/:.*@/, `:${randomPassword}@`).replace(/@.*:/, `@${randomDomain}:`));
      const hashPart = link.match(/#.*/);
      if (hashPart)
        replacedString += hashPart[0];
    } catch (error) {
      return;
    }
  }
  return replacedString;
}
function replaceTrojan(link, replacements, isRecovery) {
  const randomUUID = generateRandomUUID();
  const randomDomain = generateRandomStr(10) + ".com";
  const regexMatch = link.match(/(vless|trojan):\/\/(.*?)@(.*):/);
  if (!regexMatch) {
    return;
  }
  const [, , uuid, server] = regexMatch;
  replacements[randomDomain] = server;
  replacements[randomUUID] = uuid;
  const regex = new RegExp(`${uuid}|${server}`, "g");
  if (isRecovery) {
    return link.replace(regex, (match) => cReplace(match, uuid, replacements[uuid], server, replacements[server]));
  } else {
    return link.replace(regex, (match) => cReplace(match, uuid, randomUUID, server, randomDomain));
  }
}
function replaceHysteria(link, replacements) {
  const regexMatch = link.match(/hysteria:\/\/(.*):(.*?)\?/);
  if (!regexMatch) {
    return;
  }
  const server = regexMatch[1];
  const randomDomain = generateRandomStr(12) + ".com";
  replacements[randomDomain] = server;
  return link.replace(server, randomDomain);
}
function replaceYAML(yamlObj, replacements) {
  if (!yamlObj.proxies) {
    return;
  }
  yamlObj.proxies.forEach((proxy) => {
    const randomPassword = generateRandomStr(12);
    const randomDomain = randomPassword + ".com";
    const originalServer = proxy.server;
    proxy.server = randomDomain;
    replacements[randomDomain] = originalServer;
    if (proxy.password) {
      const originalPassword = proxy.password;
      proxy.password = randomPassword;
      replacements[randomPassword] = originalPassword;
    }
    if (proxy.uuid) {
      const originalUUID = proxy.uuid;
      const randomUUID = generateRandomUUID();
      proxy.uuid = randomUUID;
      replacements[randomUUID] = originalUUID;
    }
  });
  return yaml.dump(yamlObj);
}
function urlSafeBase64Encode(input) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function urlSafeBase64Decode(input) {
  const padded = input + "=".repeat((4 - input.length % 4) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}
function generateRandomStr(len) {
  return Math.random().toString(36).substring(2, len);
}
function generateRandomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c == "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function parseData(data) {
  try {
    return { format: "base64", data: urlSafeBase64Decode(data) };
  } catch (base64Error) {
    try {
      return { format: "yaml", data: yaml.load(data) };
    } catch (yamlError) {
      return { format: "unknown", data };
    }
  }
}
function cReplace(match, ...replacementPairs) {
  for (let i = 0; i < replacementPairs.length; i += 2) {
    if (match === replacementPairs[i]) {
      return replacementPairs[i + 1];
    }
  }
  return match;
}
export {
  src_default as default
};
//# sourceMappingURL=index.js.map
