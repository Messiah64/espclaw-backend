import { google } from "googleapis";
import { GoogleOAuthService } from "./google_oauth_service.js";
import type { ToolExecutionResult } from "../types/assistant.js";

export class DriveService {
  constructor(private readonly googleOAuth: GoogleOAuthService) {}

  async search(_userId: string, query: string): Promise<ToolExecutionResult> {
    const auth = await this.googleOAuth.getAuthorizedClient();
    const drive = google.drive({ version: "v3", auth });
    const result = await drive.files.list({
      q: query,
      pageSize: 10,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)"
    });
    return { ok: true, text: `Found ${result.data.files?.length ?? 0} Drive files.`, data: result.data.files ?? [] };
  }
}

