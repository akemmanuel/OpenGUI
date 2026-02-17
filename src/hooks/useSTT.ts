import { useCallback, useRef, useState } from "react";

interface TranscriptionResult {
	text: string;
	language: string;
	duration_seconds: number;
}

/**
 * Speech-to-text hook.
 *
 * Records audio from the microphone and sends it to a user-configured
 * transcription endpoint. The endpoint should accept a multipart form POST
 * with an "audio" file field and return JSON: { text, language, duration_seconds }.
 *
 * @param endpoint - The full URL of the STT transcription server.
 *                   When empty/undefined, recording functions are no-ops.
 */
export function useSTT(endpoint: string | undefined) {
	const [isRecording, setIsRecording] = useState(false);
	const [isTranscribing, setIsTranscribing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const streamRef = useRef<MediaStream | null>(null);

	const cleanup = useCallback(() => {
		if (streamRef.current) {
			for (const track of streamRef.current.getTracks()) {
				track.stop();
			}
			streamRef.current = null;
		}
		mediaRecorderRef.current = null;
		chunksRef.current = [];
	}, []);

	const startRecording = useCallback(async () => {
		if (!endpoint) return;
		setError(null);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			streamRef.current = stream;

			const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
				? "audio/webm;codecs=opus"
				: "audio/webm";

			const mediaRecorder = new MediaRecorder(stream, { mimeType });
			mediaRecorderRef.current = mediaRecorder;
			chunksRef.current = [];

			mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) {
					chunksRef.current.push(e.data);
				}
			};

			mediaRecorder.start(100);
			setIsRecording(true);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Microphone access denied";
			setError(message);
			cleanup();
			throw err;
		}
	}, [endpoint, cleanup]);

	const stopRecording = useCallback((): Promise<TranscriptionResult | null> => {
		return new Promise((resolve) => {
			if (!endpoint) {
				resolve(null);
				return;
			}

			const mediaRecorder = mediaRecorderRef.current;
			if (!mediaRecorder || mediaRecorder.state === "inactive") {
				setIsRecording(false);
				cleanup();
				resolve(null);
				return;
			}

			mediaRecorder.onstop = async () => {
				setIsRecording(false);
				setIsTranscribing(true);

				try {
					const audioBlob = new Blob(chunksRef.current, {
						type: "audio/webm",
					});
					cleanup();

					if (audioBlob.size < 1000) {
						setIsTranscribing(false);
						setError("Recording too short");
						resolve(null);
						return;
					}

					const formData = new FormData();
					formData.append("audio", audioBlob, "recording.webm");
					formData.append("language", "auto");

					const response = await fetch(endpoint, {
						method: "POST",
						body: formData,
					});

					if (!response.ok) {
						throw new Error(`Transcription failed (${response.status})`);
					}

					const result: TranscriptionResult = await response.json();
					setIsTranscribing(false);
					resolve(result);
				} catch (err) {
					const message =
						err instanceof Error ? err.message : "Transcription failed";
					setError(message);
					setIsTranscribing(false);
					resolve(null);
				}
			};

			mediaRecorder.stop();
		});
	}, [endpoint, cleanup]);

	const cancelRecording = useCallback(() => {
		const mediaRecorder = mediaRecorderRef.current;
		if (mediaRecorder && mediaRecorder.state !== "inactive") {
			mediaRecorder.onstop = null;
			mediaRecorder.stop();
		}
		setIsRecording(false);
		setIsTranscribing(false);
		setError(null);
		cleanup();
	}, [cleanup]);

	/** Whether STT is available (endpoint is configured). */
	const isAvailable = !!endpoint;

	return {
		isAvailable,
		isRecording,
		isTranscribing,
		error,
		startRecording,
		stopRecording,
		cancelRecording,
	};
}
