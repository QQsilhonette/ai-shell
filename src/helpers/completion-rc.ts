import { OpenAIApi, Configuration, ChatCompletionRequestMessage } from 'openai';
import dedent from 'dedent';
import { IncomingMessage } from 'http';
import { KnownError } from './error';
import { streamToIterable } from './stream-to-iterable';
import { detectShell } from './os-detect';
import type { AxiosError, AxiosResponse } from 'axios';
import { streamToString } from './stream-to-string';
import './replace-all-polyfill';
import i18n from './i18n';
import { stripRegexPatterns } from './strip-regex-patterns';
import readline from 'readline';
import axios from 'axios';
import http from 'http';
import fetch from 'node-fetch';

const explainInSecondRequest = true;

const handleStream = (response: any) => {
  // if (!response.ok)
  //   throw new Error('Network response was not ok')

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let bufferObj: any
  let isFirstMessage = true
  function read() {
    let hasError = false
    reader.read().then((result: any) => {
      if (result.done) {
        return
      }
      buffer += decoder.decode(result.value, { stream: true })
      const lines = buffer.split('\n')
      try {
        lines.forEach((message) => {
          if (message.startsWith('data: ')) { // check if it starts with data:
            console.log(message);
            try {
              bufferObj = JSON.parse(message.substring(6)) // remove data: and parse as json
            }
            catch (e) {
              return
            }
            if (bufferObj.status === 400 || !bufferObj.event) {
              hasError = true
              return
            }
            if (bufferObj.event === 'message') {
              isFirstMessage = false
            }
            else if (bufferObj.event === 'agent_thought') {
            }
          }
        })
        buffer = lines[lines.length - 1]
      }
      catch (e) {
        hasError = true
        return
      }
      if (!hasError)
        read()
    })
  }
  read()
}

// Openai outputs markdown format for code blocks. It oftne uses
// a github style like: "```bash"
const shellCodeExclusions = [/```/gi, '\n'];

export async function getScriptAndInfo({
  prompt,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string;
  key: string;
  model?: string;
  apiEndpoint: string;
}) {
  const fullPrompt = getFullPrompt(prompt);
  const stream = await generateCompletion({
    prompt: fullPrompt,
    number: 1,
    key,
    model,
    apiEndpoint,
  });
  const iterableStream = streamToIterable(stream);
  return {
    readScript: readData(iterableStream, ...shellCodeExclusions),
    readInfo: readData(iterableStream, ...shellCodeExclusions),
  };
}

export async function generateCompletion({
  prompt,
  number = 1,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string | ChatCompletionRequestMessage[];
  number?: number;
  model?: string;
  key: string;
  apiEndpoint: string;
}) {
    const uri = '/completion-messages';
    const data = {
      'inputs': {
        'query': Array.isArray(prompt)
        ? prompt[prompt.length - 1].content
        : prompt,
      },
      'response_mode': 'streaming',
      'user': 'rokey.luo'
    };
    const url = apiEndpoint + uri
    const body = JSON.stringify(data)
    const headers = {'Content-Type': 'application/json','Authorization': `Bearer ${key}`}
    const response = await axios.post(url, body, { headers: headers })
    return response.data;
}

export async function getExplanation({
  script,
  key,
  model,
  apiEndpoint,
}: {
  script: string;
  key: string;
  model?: string;
  apiEndpoint: string;
}) {
  const prompt = getExplanationPrompt(script);
  const stream = await generateCompletion({
    prompt,
    key,
    number: 1,
    model,
    apiEndpoint,
  });
  const iterableStream = streamToIterable(stream);
  return { readExplanation: readData(iterableStream) };
}

export async function getRevision({
  prompt,
  code,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string;
  code: string;
  key: string;
  model?: string;
  apiEndpoint: string;
}) {
  const fullPrompt = getRevisionPrompt(prompt, code);
  const stream = await generateCompletion({
    prompt: fullPrompt,
    key,
    number: 1,
    model,
    apiEndpoint,
  });
  const iterableStream = streamToIterable(stream);
  return {
    readScript: readData(iterableStream, ...shellCodeExclusions),
  };
}

export const readData_new =
  (
    iterableStream: AsyncGenerator<string, void>,
    ...excluded: (RegExp | string | undefined)[]
  ) =>
  (writer: (data: string) => void): Promise<string> =>
    new Promise(async (resolve) => {
      let stopTextStream = false;
      let data = '';
      let content = '';
      let dataStart = false;
      let buffer = ''; // This buffer will temporarily hold incoming data only for detecting the start

      const [excludedPrefix] = excluded;
      const stopTextStreamKeys = ['q', 'escape']; //Group of keys that stop the text stream

      const rl = readline.createInterface({
        input: process.stdin,
      });

      process.stdin.setRawMode(true);

      process.stdin.on('keypress', (key, data) => {
        if (stopTextStreamKeys.includes(data.name)) {
          stopTextStream = true;
        }
      });
      let payload = '';
      for await (const chunk of iterableStream) {
        if (stopTextStream) {
          dataStart = false;
          resolve(data);
          return;
        }
        if (chunk != '\n') {
          payload += chunk;
          continue;
        }
        if (payload.startsWith('data:')) {
          content = parseContent(payload);
          // Use buffer only for start detection
          if (!dataStart) {
            // Append content to the buffer
            buffer += content;
            if (buffer.match(excludedPrefix ?? '')) {
              dataStart = true;
              // Clear the buffer once it has served its purpose
              buffer = '';
              if (excludedPrefix) break;
            }
          }

          if (dataStart && content) {
            const contentWithoutExcluded = stripRegexPatterns(
              content,
              excluded
            );

            data += contentWithoutExcluded;
            writer(contentWithoutExcluded);
          }
        }
        payload = '';
      }

      function parseContent(payload: string): string {
        const data = payload.replaceAll(/(\n)?^data:\s*/g, '');
        try {
          const delta = JSON.parse(data.trim());
          return delta.answer;
        } catch (error) {
          return `Error with JSON.parse and ${payload}.\n${error}`;
        }
      }

      resolve(data);
    });


export const readData =
(
  iterableStream: AsyncGenerator<string, void>,
  ...excluded: (RegExp | string | undefined)[]
) =>
(writer: (data: string) => void): Promise<string> =>
  new Promise(async (resolve) => {
    let stopTextStream = false;
    let data = '';
    let content = '';
    let dataStart = false;
    let buffer = ''; // This buffer will temporarily hold incoming data only for detecting the start

    const [excludedPrefix] = excluded;
    const stopTextStreamKeys = ['q', 'escape']; //Group of keys that stop the text stream

    const rl = readline.createInterface({
      input: process.stdin,
    });

    process.stdin.setRawMode(true);

    process.stdin.on('keypress', (key, data) => {
      if (stopTextStreamKeys.includes(data.name)) {
        stopTextStream = true;
      }
    });
    for await (const chunk of iterableStream) {
      const payloads = chunk.toString().split('\n\n');
      for (const payload of payloads) {
        if (payload.includes('message_end') || stopTextStream) {
          dataStart = false;
          resolve(data);
          return;
        }

        if (payload.startsWith('data:')) {
          content = parseContent(payload);
          // Use buffer only for start detection
          if (!dataStart) {
            // Append content to the buffer
            buffer += content;
            if (buffer.match(excludedPrefix ?? '')) {
              dataStart = true;
              // Clear the buffer once it has served its purpose
              buffer = '';
              if (excludedPrefix) break;
            }
          }

          if (dataStart && content) {
            const contentWithoutExcluded = stripRegexPatterns(
              content,
              excluded
            );
            data += contentWithoutExcluded;
            writer(contentWithoutExcluded);
          }
        }
      }
    }

    function parseContent(payload: string): string {
      const data = payload.replaceAll(/(\n)?^data:\s*/g, '');
      try {
        const delta = JSON.parse(data.trim());
        return delta.answer;
      } catch (error) {
        return `Error with JSON.parse and ${payload}.\n${error}`;
      }
    }

    resolve(data);
  });

function getExplanationPrompt(script: string) {
  return dedent`
    ${explainScript} Please reply in ${i18n.getCurrentLanguagenName()}

    The script: ${script}
  `;
}

function getShellDetails() {
  const shellDetails = detectShell();

  return dedent`
      The target shell is ${shellDetails}
  `;
}
const shellDetails = getShellDetails();

const explainScript = dedent`
  Please provide a clear, concise description of the script, using minimal words. Outline the steps in a list format.
`;

function getOperationSystemDetails() {
  const os = require('@nexssp/os/legacy');
  return os.name();
}
const generationDetails = dedent`
    Only reply with the single line command surrounded by three backticks. It must be able to be directly run in the target shell. Do not include any other text.

    Make sure the command runs on ${getOperationSystemDetails()} operating system.
  `;

function getFullPrompt(prompt: string) {
  return dedent`
    Create a single line command that one can enter in a terminal and run, based on what is specified in the prompt.

    ${shellDetails}

    ${generationDetails}

    ${explainInSecondRequest ? '' : explainScript}

    The prompt is: ${prompt}
  `;
}

function getRevisionPrompt(prompt: string, code: string) {
  return dedent`
    Update the following script based on what is asked in the following prompt.

    The script: ${code}

    The prompt: ${prompt}

    ${generationDetails}
  `;
}
