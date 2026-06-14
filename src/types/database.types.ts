// ============================================================
// Database types — manually maintained until `supabase gen types`
// can be run against the live project.
//
// Run: npx supabase gen types typescript --project-id YOUR_REF > src/types/database.types.ts
// to regenerate after migrations.
// ============================================================

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---- Enums -------------------------------------------------

export type ChannelType = 'whatsapp' | 'instagram' | 'email' | 'sms';
export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'unqualified'
  | 'negotiating'
  | 'converted'
  | 'lost'
  | 'archived';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageSenderType = 'lead' | 'agent' | 'ai_bot' | 'system';
export type ConversationStatus = 'open' | 'pending_reply' | 'resolved' | 'archived';
export type FollowupStatus = 'pending' | 'completed' | 'cancelled' | 'overdue';
export type AiIntent =
  | 'purchase_intent'
  | 'inquiry'
  | 'support'
  | 'complaint'
  | 'spam'
  | 'unsubscribe'
  | 'greeting'
  | 'other';
export type WebhookStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'duplicate';
export type OrgMemberRole = 'owner' | 'admin' | 'agent';
export type OrgPlan = 'free' | 'starter' | 'pro' | 'enterprise';

// ---- Table row types ----------------------------------------

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  seat_limit: number | null;
  monthly_lead_limit: number | null;
  contact_email: string | null;
  contact_phone: string | null;
  website_url: string | null;
  settings: Json;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrgMemberRole;
  invited_by: string | null;
  invited_at: string;
  joined_at: string | null;
  invitation_token: string | null;
  removed_at: string | null;
  removed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaIntegration {
  id: string;
  organization_id: string;
  page_id: string;
  page_name: string | null;
  app_id: string;
  // access_token_encrypted is NEVER returned in client queries; only via admin client
  access_token_encrypted: string;
  allowed_form_ids: string[] | null;
  is_active: boolean;
  last_webhook_received_at: string | null;
  last_successful_lead_at: string | null;
  total_leads_ingested: number;
  webhook_subscribed_fields: string[];
  created_at: string;
  updated_at: string;
}

// Safe (redacted) version used in client-facing code
export type MetaIntegrationSafe = Omit<MetaIntegration, 'access_token_encrypted'>;

export interface Lead {
  id: string;
  organization_id: string;
  phone_e164: string | null;
  email: string | null;
  name: string | null;
  first_name: string | null; // generated column
  channel: ChannelType;
  whatsapp_id: string | null;
  meta_lead_id: string | null;
  external_id: string | null;
  ad_id: string | null;
  ad_name: string | null;
  form_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  assigned_agent_id: string | null;
  status: LeadStatus;
  qualified_at: string | null;
  converted_at: string | null;
  last_contacted_at: string | null;
  last_reply_at: string | null;
  metadata: Json;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  lead_id: string;
  assigned_agent_id: string | null;
  channel: ChannelType;
  status: ConversationStatus;
  resolved_at: string | null;
  archived_at: string | null;
  message_count: number;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  whatsapp_window_expires_at: string | null;
  ai_context: Json;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  organization_id: string;
  conversation_id: string;
  lead_id: string;
  direction: MessageDirection;
  sender_type: MessageSenderType;
  sender_agent_id: string | null;
  whatsapp_message_id: string | null;
  external_message_id: string | null;
  message_type: string;
  content: string | null;
  raw_payload: Json;
  media_url: string | null;
  media_mime_type: string | null;
  media_sha256: string | null;
  template_name: string | null;
  template_language: string | null;
  delivery_status: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  agent_read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadNote {
  id: string;
  organization_id: string;
  lead_id: string;
  agent_id: string;
  content: string;
  note_type: string;
  is_pinned: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Followup {
  id: string;
  organization_id: string;
  lead_id: string;
  conversation_id: string | null;
  assigned_agent_id: string | null;
  created_by_agent_id: string | null;
  title: string;
  description: string | null;
  followup_type: string;
  scheduled_at: string;
  snooze_count: number;
  snoozed_until: string | null;
  status: FollowupStatus;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  completed_message_id: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface AiClassification {
  id: string;
  organization_id: string;
  lead_id: string;
  message_id: string | null;
  conversation_id: string | null;
  intent: AiIntent;
  confidence: number;
  sentiment: string | null;
  sentiment_score: number | null;
  qualification_score: number | null;
  summary: string | null;
  suggested_action: string | null;
  action_taken: boolean;
  action_taken_at: string | null;
  action_details: Json;
  model_provider: string;
  model_name: string;
  model_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  raw_prompt: string | null;
  raw_completion: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  organization_id: string | null; // Nullable: resolved after page_id routing
  source: string;
  idempotency_key: string;
  external_event_id: string | null;
  http_method: string;
  request_headers: Json;
  raw_body: string;
  parsed_payload: Json | null;
  status: WebhookStatus;
  processing_started_at: string | null;
  processed_at: string | null;
  attempt_count: number;
  last_error: string | null;
  retry_after: string | null;
  lead_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  received_at: string;
}

// ---- Database interface (mirrors Supabase generated shape) --
// GenericSchema (from @supabase/supabase-js) requires:
//   Tables:    each entry has Row, Insert, Update, Relationships (required array)
//   Views:     each entry has Row, Relationships (required array)
//   Functions: each entry has Args, Returns
// If ANY table is missing Relationships, Database.public won't satisfy
// GenericSchema, Schema defaults to `never`, and all .from()/.rpc() calls
// become typed as `never`.

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: Organization;
        Insert: Partial<Organization> & { name: string; slug: string };
        Update: Partial<Organization>;
        Relationships: [];
      };
      organization_members: {
        Row: OrganizationMember;
        Insert: Partial<OrganizationMember> & {
          organization_id: string;
          user_id: string;
        };
        Update: Partial<OrganizationMember>;
        Relationships: [];
      };
      meta_integrations: {
        Row: MetaIntegration;
        Insert: Partial<MetaIntegration> & {
          organization_id: string;
          page_id: string;
          app_id: string;
          access_token_encrypted: string;
        };
        Update: Partial<MetaIntegration>;
        Relationships: [];
      };
      leads: {
        Row: Lead;
        Insert: Partial<Lead> & { organization_id: string; channel: ChannelType };
        Update: Partial<Lead>;
        Relationships: [];
      };
      conversations: {
        Row: Conversation;
        Insert: Partial<Conversation> & {
          organization_id: string;
          lead_id: string;
          channel: ChannelType;
        };
        Update: Partial<Conversation>;
        Relationships: [];
      };
      messages: {
        Row: Message;
        Insert: Partial<Message> & {
          organization_id: string;
          conversation_id: string;
          lead_id: string;
          direction: MessageDirection;
          sender_type: MessageSenderType;
        };
        Update: Partial<Message>;
        Relationships: [];
      };
      lead_notes: {
        Row: LeadNote;
        Insert: Partial<LeadNote> & {
          organization_id: string;
          lead_id: string;
          agent_id: string;
          content: string;
        };
        Update: Partial<LeadNote>;
        Relationships: [];
      };
      followups: {
        Row: Followup;
        Insert: Partial<Followup> & {
          organization_id: string;
          lead_id: string;
          title: string;
          scheduled_at: string;
        };
        Update: Partial<Followup>;
        Relationships: [];
      };
      ai_classifications: {
        Row: AiClassification;
        Insert: Partial<AiClassification> & {
          organization_id: string;
          lead_id: string;
          intent: AiIntent;
          confidence: number;
          model_provider: string;
          model_name: string;
        };
        Update: Partial<AiClassification>;
        Relationships: [];
      };
      webhook_events: {
        Row: WebhookEvent;
        Insert: Partial<WebhookEvent> & {
          source: string;
          idempotency_key: string;
          raw_body: string;
        };
        Update: Partial<WebhookEvent>;
        Relationships: [];
      };
    };
    // Views defined in migrations
    Views: {
      ai_classifications_summary: {
        Row: Omit<AiClassification, 'raw_prompt' | 'raw_completion'>;
        Relationships: [];
      };
      meta_integrations_safe: {
        Row: MetaIntegrationSafe;
        Relationships: [];
      };
    };
    Functions: {
      upsert_lead_from_meta_ad: {
        Args: {
          p_organization_id: string;
          p_meta_lead_id: string;
          p_phone_e164: string | null;
          p_name: string | null;
          p_email: string | null;
          p_ad_id: string | null;
          p_ad_name: string | null;
          p_ad_set_id: string | null;
          p_ad_set_name: string | null;
          p_form_id: string | null;
          p_campaign_id: string | null;
          p_campaign_name: string | null;
          p_source_url?: string | null;
          p_metadata?: Json;
        };
        Returns: Lead;
      };
      get_or_create_open_conversation: {
        Args: {
          p_organization_id: string;
          p_lead_id: string;
          p_channel?: ChannelType;
        };
        Returns: Conversation;
      };
    };
  };
}
