const BASE_URL = 'https://api.trello.com/1';

interface TrelloCredentials {
  key: string;
  token: string;
}

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  shortUrl: string;
  idList: string;
  idBoard: string;
}

export class TrelloApi {
  constructor(private readonly credentials: TrelloCredentials) {}

  async getCard(cardId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>(`/cards/${cardId}`, {
      fields: 'name,desc,url,shortUrl,idList,idBoard',
    });
  }

  async moveCard(cardId: string, listId: string): Promise<TrelloCard> {
    return this.put<TrelloCard>(`/cards/${cardId}`, { idList: listId });
  }

  async addComment(cardId: string, text: string): Promise<void> {
    await this.post(`/cards/${cardId}/actions/comments`, { text });
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);

    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('key', this.credentials.key);
    url.searchParams.set('token', this.credentials.token);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}
