/**
 * Cloudflare Worker for Screenless Voice Recording
 *
 * This worker handles Twilio voice calls by:
 * 1. Recording incoming calls
 * 2. Transcribing the recording using Deepgram
 * 3. Sending the transcript via email using SendGrid
 * 4. Deleting the original recording from Twilio
 */

interface Env {
  DEEPGRAM_SECRET: string;
  SENDGRID_SECRET: string;
  SENDGRID_FROM_EMAIL: string;
  SENDGRID_FROM_NAME: string;
  SENDGRID_TO_EMAIL: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
}

interface TwilioCallWebhook {
  From?: string;
  To?: string;
  CallSid?: string;
  RecordingUrl?: string;
  RecordingSid?: string;
  RecordingDuration?: string;
}

interface DeepgramTranscript {
  transcriptHtml?: string;
  transcript?: string;
  averageWordConfidence?: number;
  speakerAmount?: number;
  uncertainWordPercentage?: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle initial call - start recording
    if (url.pathname === "/record" && request.method === "POST") {
      return handleInitialCall(request);
    }

    // Handle recording completion - transcribe and email
    if (url.pathname === "/recording-complete" && request.method === "POST") {
      return handleRecordingComplete(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Handle initial incoming call - respond with TwiML to start recording
 */
async function handleInitialCall(request: Request): Promise<Response> {
  const formData = await request.text();
  const params = new URLSearchParams(formData);

  const from = params.get("From") || "Unknown";
  const to = params.get("To") || "Unknown";

  console.log(`Incoming call from ${from} to ${to}`);

  // TwiML response to record the call
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Welcome to Screenless. Your call is being recorded. Please leave your message after the beep.</Say>
  <Record 
    timeout="10" 
    maxLength="600"
    playBeep="true"
    recordingStatusCallback="${new URL(
      "/recording-complete",
      request.url,
    ).toString()}"
    recordingStatusCallbackMethod="POST"
    transcribe="false"
  />
  <Say>Thank you for your message. Goodbye.</Say>
</Response>`;

  return new Response(twiml, {
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Handle recording completion - transcribe, email, and delete
 */
async function handleRecordingComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const formData = await request.text();
    const params = new URLSearchParams(formData);

    const recordingUrl = params.get("RecordingUrl");
    const recordingSid = params.get("RecordingSid");
    const from = params.get("From") || "Unknown";
    const duration = params.get("RecordingDuration") || "0";

    if (!recordingUrl) {
      console.error("No recording URL provided");
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        {
          headers: { "Content-Type": "text/xml" },
        },
      );
    }

    console.log(`Processing recording: ${recordingUrl}`);

    // Wait for recording to be available
    await waitForRecording(recordingUrl, env);

    // Transcribe the recording
    const transcript = await transcribeRecording(recordingUrl, env, from);

    if (!transcript || !transcript.transcript) {
      console.error("Failed to get transcript");
      return respondWithEmptyTwiML();
    }

    // Send email with transcript
    await sendTranscriptEmail(transcript, from, duration, recordingUrl, env);

    // Delete the original recording from Twilio
    if (recordingSid) {
      await deleteRecording(recordingSid, env);
    }

    console.log("Processing complete");

    return respondWithEmptyTwiML();
  } catch (error) {
    console.error("Error processing recording:", error);
    return respondWithEmptyTwiML();
  }
}

/**
 * Wait for recording to be available (with retries)
 */
async function waitForRecording(
  url: string,
  env: Env,
  maxAttempts = 10,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          Authorization:
            "Basic " +
            btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        },
      });

      if (
        response.ok &&
        response.headers.get("Content-Type")?.includes("audio")
      ) {
        return;
      }
    } catch (e) {
      // Ignore and retry
    }

    // Wait 1 second before retry
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Recording not available after retries");
}

/**
 * Transcribe recording using Deepgram
 */
async function transcribeRecording(
  audioUrl: string,
  env: Env,
  speakerIdentifier?: string,
): Promise<DeepgramTranscript | null> {
  try {
    const response = await fetch("https://api.deepgram.com/v1/listen", {
      method: "POST",
      headers: {
        Authorization: `Token ${env.DEEPGRAM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: audioUrl,
        model: "nova-2-general",
        diarize: true,
        detect_language: true,
        smart_format: true,
        punctuate: true,
        utterances: true,
        summarize: true,
      }),
    });

    if (!response.ok) {
      console.error("Deepgram API error:", await response.text());
      return null;
    }

    const result = await response.json();
    return analyzeDeepgramResponse(result, speakerIdentifier);
  } catch (error) {
    console.error("Error transcribing:", error);
    return null;
  }
}

/**
 * Analyze Deepgram response and format transcript
 */
function analyzeDeepgramResponse(
  apiResult: any,
  speakerIdentifier?: string,
): DeepgramTranscript {
  const channels = apiResult.results?.channels || [];

  if (channels.length === 0) {
    return { transcript: "", transcriptHtml: "" };
  }

  const words = channels[0]?.alternatives?.[0]?.words || [];
  const paragraphs =
    channels[0]?.alternatives?.[0]?.paragraphs?.paragraphs || [];

  let transcript = "";
  let previousSpeaker = -1;

  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.sentences || []) {
      const speaker = paragraph.speaker ?? 0;
      const speakerLabel = speakerIdentifier || `Speaker ${speaker + 1}`;

      // Add speaker label if changed
      if (speaker !== previousSpeaker) {
        const minutes = Math.floor(sentence.start / 60);
        const seconds = Math.floor(sentence.start % 60);
        transcript += `\n\n${speakerLabel} (${minutes}:${seconds
          .toString()
          .padStart(2, "0")}): `;
        previousSpeaker = speaker;
      }

      transcript += sentence.text + " ";
    }
  }

  // Calculate confidence metrics
  const confidences = words.map((w: any) => w.confidence || 0);
  const avgConfidence =
    confidences.length > 0
      ? confidences.reduce((a: number, b: number) => a + b, 0) /
        confidences.length
      : 0;

  const uncertainWords = confidences.filter((c: number) => c < 0.7).length;
  const uncertainPercentage =
    confidences.length > 0 ? uncertainWords / confidences.length : 0;

  // Count unique speakers
  const speakers = new Set(paragraphs.map((p: any) => p.speaker ?? 0));

  // Convert to HTML
  const transcriptHtml = markdownToHtml(transcript.trim());

  return {
    transcript: transcript.trim(),
    transcriptHtml,
    averageWordConfidence: Math.round(avgConfidence * 1000) / 1000,
    uncertainWordPercentage: Math.round(uncertainPercentage * 1000) / 1000,
    speakerAmount: speakers.size,
  };
}

/**
 * Simple markdown to HTML converter
 */
function markdownToHtml(markdown: string): string {
  let html = markdown
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");

  return `<p>${html}</p>`;
}

/**
 * Send transcript via email using SendGrid
 */
async function sendTranscriptEmail(
  transcript: DeepgramTranscript,
  from: string,
  duration: string,
  recordingUrl: string,
  env: Env,
): Promise<void> {
  const subject = `Screenless Recording from ${from}`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${subject}</title>
</head>
<body>
  <h1>Screenless Recording</h1>
  
  <h2>Call Details</h2>
  <ul>
    <li><strong>From:</strong> ${from}</li>
    <li><strong>Duration:</strong> ${duration} seconds</li>
    <li><strong>Speakers:</strong> ${transcript.speakerAmount || 1}</li>
    <li><strong>Confidence:</strong> ${(
      (transcript.averageWordConfidence || 0) * 100
    ).toFixed(1)}%</li>
  </ul>
  
  <h2>Transcript</h2>
  <div>
    ${transcript.transcriptHtml || "<p>No transcript available</p>"}
  </div>
  
  <hr>
  <p><small>Recorded with Screenless - Original recording has been deleted for privacy</small></p>
</body>
</html>`;

  const textContent = `
Screenless Recording

From: ${from}
Duration: ${duration} seconds
Speakers: ${transcript.speakerAmount || 1}
Confidence: ${((transcript.averageWordConfidence || 0) * 100).toFixed(1)}%

Transcript:
${transcript.transcript || "No transcript available"}

---
Recorded with Screenless - Original recording has been deleted for privacy
`.trim();

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SENDGRID_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: env.SENDGRID_TO_EMAIL }],
          },
        ],
        from: {
          email: env.SENDGRID_FROM_EMAIL,
          name: env.SENDGRID_FROM_NAME || "Screenless",
        },
        subject,
        content: [
          {
            type: "text/plain",
            value: textContent,
          },
          {
            type: "text/html",
            value: htmlContent,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("SendGrid error:", await response.text());
      throw new Error("Failed to send email");
    }

    console.log("Email sent successfully");
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

/**
 * Delete recording from Twilio
 */
async function deleteRecording(recordingSid: string, env: Env): Promise<void> {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.json`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization:
          "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      },
    });

    if (response.ok) {
      console.log(`Recording ${recordingSid} deleted successfully`);
    } else {
      console.error("Failed to delete recording:", await response.text());
    }
  } catch (error) {
    console.error("Error deleting recording:", error);
  }
}

/**
 * Return empty TwiML response
 */
function respondWithEmptyTwiML(): Response {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    {
      headers: { "Content-Type": "text/xml" },
    },
  );
}
