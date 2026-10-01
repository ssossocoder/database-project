export type PublicRow = Record<string, unknown>;
export type Service = 'applyhome' | 'molit' | 'mois';
export type Query = Record<string, string | number>;

export interface ResponseEvidence {
  service: Service;
  endpoint: string;
  params: Query;
  fetchedAt: string;
  httpStatus: number;
  contentType: string;
  raw: string;
}

export interface DataPage extends ResponseEvidence {
  rows: PublicRow[];
  page: number;
  perPage: number;
  /** 필터 적용 후 건수. 청약홈은 matchCount를 사용한다. */
  totalCount: number;
  /** 청약홈의 필터 적용 전 totalCount. 다른 API는 생략. */
  universeCount?: number;
}

export interface CollectedPages {
  rows: PublicRow[];
  pages: DataPage[];
  totalCount: number;
  complete: true;
}
