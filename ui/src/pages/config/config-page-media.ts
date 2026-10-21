import type { UiSettings } from "../../app/settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  realtimeTalkDeviceIssueMessage,
} from "../chat/talk/input.ts";
import { switchActiveRealtimeTalkCameras } from "../chat/talk/session.ts";
import { createMediaDeviceState } from "./view-state.ts";

type ConfigPageMediaHost = {
  invalidate: () => void;
  applySettings: (patch: Partial<UiSettings>) => void;
};

/** Owns picker discovery and camera selection, including superseded requests. */
export function createConfigPageMedia({ invalidate, applySettings }: ConfigPageMediaHost) {
  let mediaDeviceWatch: (() => void) | null = null;
  const mediaDevices = {
    microphone: createMediaDeviceState(),
    camera: createMediaDeviceState(),
  };
  let cameraSelectionRequest = 0;

  function retireMediaPermissionRequests() {
    for (const device of Object.values(mediaDevices)) {
      device.requestsPermission = false;
    }
  }

  async function refreshMediaDevices(kind: "microphone" | "camera", requestPermission: boolean) {
    const device = mediaDevices[kind];
    if (device.loading) {
      device.requestsPermission ||= requestPermission;
      return;
    }
    device.loading = true;
    device.requestsPermission = requestPermission;
    device.error = null;
    invalidate();
    try {
      const discover =
        kind === "microphone" ? discoverRealtimeTalkInputs : discoverRealtimeTalkCameras;
      const result = await discover(() => device.requestsPermission);
      device.devices = result.devices;
      device.permissionRequired = result.permissionRequired;
      device.error = result.issue
        ? realtimeTalkDeviceIssueMessage(
            result.issue,
            kind === "microphone" ? "audioinput" : "videoinput",
          )
        : null;
    } catch (error) {
      // Discovery is best-effort in blocked/inactive contexts; a rejection
      // must not wedge the picker in its loading state.
      device.error = formatUiError(error);
    } finally {
      device.loading = false;
      device.requestsPermission = false;
      invalidate();
    }
  }

  async function selectCamera(deviceId: string) {
    const request = ++cameraSelectionRequest;
    const videoDeviceId = deviceId.trim() || undefined;
    mediaDevices.camera.error = null;
    invalidate();
    try {
      await switchActiveRealtimeTalkCameras(videoDeviceId);
      if (request !== cameraSelectionRequest) {
        return;
      }
      // Persist only a camera the active Talk session accepted. A superseded
      // request must not overwrite the newer confirmed selection.
      applySettings({
        realtimeTalkVideoDeviceId: videoDeviceId,
      });
    } catch (error) {
      if (request === cameraSelectionRequest) {
        mediaDevices.camera.error = formatUiError(error);
        invalidate();
      }
    }
  }

  return {
    devices: mediaDevices,
    ensureLoaded: () => {
      for (const kind of ["microphone", "camera"] as const) {
        if (!mediaDevices[kind].loaded) {
          mediaDevices[kind].loaded = true;
          void refreshMediaDevices(kind, false);
        }
      }
    },
    retirePermissionRequests: retireMediaPermissionRequests,
    refresh: refreshMediaDevices,
    selectCamera,
    startWatching: () => {
      mediaDeviceWatch = observeRealtimeTalkDevices(() => {
        void refreshMediaDevices("microphone", false);
        void refreshMediaDevices("camera", false);
      });
    },
    stopWatching: () => {
      mediaDeviceWatch?.();
      mediaDeviceWatch = null;
    },
  };
}
