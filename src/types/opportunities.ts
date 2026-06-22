export interface Opportunity {
  id: string;
  name: string;
  amount?: {
    amountMicros: number;
    currencyCode: string;
  };
  stage?: string;
  closeDate?: string;
  companyId?: string;
  pointOfContactId?: string;
  createdAt: string;
  updatedAt: string;
  // Operator-declared custom fields (CUSTOM_OPPORTUNITY_FIELDS) surface here at
  // runtime by their Twenty API name. Kept as an index signature so custom
  // fields stay config-driven rather than hardcoded into this type.
  [customField: string]: unknown;
}

export interface CreateOpportunityInput {
  name: string;
  amount?: {
    amountMicros: number;
    currencyCode: string;
  };
  stage?: string;
  closeDate?: string;
  companyId?: string;
  pointOfContactId?: string;
}

export interface UpdateOpportunityInput {
  id: string;
  name?: string;
  amount?: {
    amountMicros: number;
    currencyCode: string;
  };
  stage?: string;
  closeDate?: string;
  companyId?: string;
  pointOfContactId?: string;
}

export interface SearchOpportunitiesInput {
  query?: string;
  stage?: string;
  minAmount?: number;
  maxAmount?: number;
  startDate?: string;
  endDate?: string;
  companyId?: string;
  limit?: number;
  offset?: number;
}

export interface OpportunityStage {
  value: string;
  label: string;
  position: number;
  color: string;
}