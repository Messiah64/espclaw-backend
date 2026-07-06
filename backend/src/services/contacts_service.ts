import { google } from "googleapis";
import { GoogleOAuthService } from "./google_oauth_service.js";
import type { ToolExecutionResult } from "../types/assistant.js";

export class ContactsService {
  constructor(private readonly googleOAuth: GoogleOAuthService) {}

  async search(_userId: string, query: string): Promise<ToolExecutionResult> {
    const auth = await this.googleOAuth.getAuthorizedClient();
    const people = google.people({ version: "v1", auth });
    const result = await people.people.searchContacts({
      query,
      readMask: "names,emailAddresses,phoneNumbers",
      pageSize: 10
    });
    return { ok: true, text: `Found ${result.data.results?.length ?? 0} contacts.`, data: result.data.results ?? [] };
  }
}

