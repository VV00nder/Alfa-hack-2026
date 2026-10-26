export type Role = "CLIENT" | "ANALYST" | "RISK_MANAGER" | "ADMIN";

export interface Company {
  id: string;
  inn: string;
  ogrn: string | null;
  name: string;
  legal_form: string;
  okved: string | null;
  okved_name: string | null;
  region: string | null;
  address: string | null;
  director_name: string | null;
  registration_date: string | null;
  segment: string;
  employees: number | null;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  position: string | null;
  role: Role;
  company: Company | null;
}

export interface Product {
  code: string;
  name: string;
  tagline: string;
  description: string;
  min_amount: number;
  max_amount: number;
  min_term: number;
  max_term: number;
  margin: number;
  collateral_required: boolean;
  guarantee_required: boolean;
  requires_account: boolean;
  purposes: string[];
  required_documents: string[];
  decision_time: string;
  rate_from: number | null;
}

export interface OfferOption {
  kind: string;
  product_code: string;
  product_name: string;
  amount: number;
  term_months: number;
  rate: number;
  monthly_payment: number;
  total_payment: number;
  overpayment: number;
  note: string;
}

export interface AppEvent {
  id: string;
  created_at: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  actor_name: string | null;
  message: string;
  details: Record<string, unknown>;
}

export interface Doc {
  id: string;
  doc_type: string;
  filename: string;
  content_type: string;
  size: number;
  parsed: { ok?: boolean; months?: number; operations?: number; avg_monthly_inflow?: number; period?: string; error?: string };
  created_at: string;
}

export interface InfoItem {
  code: string;
  type: "field" | "document";
  doc_type?: string;
  text: string;
}

export interface Factor {
  code?: string;
  label: string;
  value: string;
  points?: number;
  impact?: "positive" | "negative" | "neutral";
  hint: string;
}

export interface Scoring {
  model_version?: string;
  score?: number;
  grade?: string;
  pd?: number;
  factors: Factor[];
  stop_factors?: { code: string; label: string }[];
  manual_triggers?: { code: string; label: string }[];
  eligibility_issues?: string[];
  affordability: Record<string, number>;
  decision?: { outcome: string; reasons: string[]; recommended_offer: OfferOption | null; alternatives: OfferOption[]; improvement_tips: string[] };
  improvement_tips?: string[];
  features?: Record<string, unknown>;
}

export interface ApplicationShort {
  id: string;
  number: string;
  product_code: string;
  amount: number;
  term_months: number;
  purpose: string | null;
  status: string;
  status_label: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  company_name: string | null;
  company_inn: string | null;
  grade: string | null;
  score: number | null;
  assigned_to: string | null;
  sla_minutes: number | null;
}

export interface Application extends ApplicationShort {
  purpose_comment: string | null;
  form_data: {
    financials?: { revenue_last_year?: number; expenses_last_year?: number; existing_monthly_payments?: number; employees?: number };
    collateral?: { type?: string; description?: string; estimated_value?: number };
    contact?: { name?: string; position?: string; phone?: string };
    owner_guarantee?: boolean;
    company_confirmed?: boolean;
  };
  consents: { bki?: boolean; personal_data?: boolean };
  validation: Record<string, unknown>;
  info_request: { items?: InfoItem[]; message?: string; by?: string; response?: { comment?: string } | null };
  offer: { options?: OfferOption[]; valid_until?: string; conditions?: string[]; selected_index?: number | null };
  decision: { outcome?: string; reasons?: string[]; tips?: string[]; by?: string; proposal?: Record<string, unknown> };
  loan: {
    contract_number?: string;
    loan_id?: string;
    account?: string;
    amount?: number;
    rate?: number;
    term_months?: number;
    monthly_payment?: number;
    schedule?: { n: number; date: string; payment: number; principal: number; interest: number; balance: number }[];
  };
  status_hint: string;
  stage: number;
  next_action: string | null;
  required_documents: string[];
  documents: Doc[];
  events: AppEvent[];
  product: Product;
  enrichment: Record<string, any> | null;
  scoring: Scoring | null;
  company: Company;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  tags: Record<string, string[]>;
  priority: number;
  source: string | null;
  cta_label: string | null;
  cta_link: string | null;
  published_at: string;
  is_active?: boolean;
  relevance: number | null;
  reasons: string[];
}

export interface Notification {
  id: string;
  application_id: string | null;
  kind: string;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

export interface Recommendation {
  product_code: string;
  name: string;
  tagline: string;
  fit: number;
  reasons: string[];
  limitations: string[];
  rate_from: number;
  example_amount: number;
  example_term: number;
  example_payment: number;
  decision_time: string;
}
