import { AfterViewChecked, Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../services/auth.service';
import { RouterLink } from '@angular/router';

type ChatMessage = { from: 'bot' | 'user'; text: string };

@Component({
  selector: 'app-support-chat', standalone: true, imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './support-chat.html', styleUrl: './support-chat.css',
})
export class SupportChatComponent implements AfterViewChecked {
  @ViewChild('messagesBottom') private messagesBottom?: ElementRef<HTMLDivElement>;
  private shouldScrollMessages = false;
  open = false; sending = false; draft = '';
  trackingNumber?: string;
  requiresTracking = false;
  suggestions = ['How do I send a parcel?', 'Track my parcel', 'How does locker collection work?'];
  messages: ChatMessage[] = [{ from: 'bot', text: 'Hi, I am SendIT Assist. Ask me about SendIT without signing in. To track a parcel, paste its tracking ID or sign in to view your parcels.' }];
  constructor(private readonly http: HttpClient, private readonly auth: AuthService) {}
  get isCustomer() { return this.auth.getCurrentUser()?.role === 'CUSTOMER'; }
  get isLoggedIn() { return !!this.auth.getCurrentUser(); }
  toggle() { this.open = !this.open; }
  ngAfterViewChecked() {
    if (this.open && this.shouldScrollMessages) {
      this.messagesBottom?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
      this.shouldScrollMessages = false;
    }
  }
  ask(prompt: string) { this.draft = prompt; this.send(); }
  send() {
    const message = this.draft.trim(); if (!message || this.sending) return;
    this.messages.push({ from: 'user', text: message }); this.draft = ''; this.shouldScrollMessages = true;
    this.sending = true;
    this.http.post<{ reply: string; trackingNumber?: string; requiresTracking?: boolean; suggestions?: string[] }>(`${environment.apiUrl}/support-chat/message`, { message, trackingNumber: this.trackingNumber }).subscribe({
      next: (result) => {
        this.messages.push({ from: 'bot', text: result.reply });
        this.shouldScrollMessages = true;
        this.trackingNumber = result.requiresTracking ? undefined : (result.trackingNumber ?? this.trackingNumber);
        this.requiresTracking = !!result.requiresTracking;
        if (result.suggestions) this.suggestions = result.suggestions;
        this.sending = false;
      },
      error: () => { this.messages.push({ from: 'bot', text: 'I could not load your parcel details right now. Please try again shortly.' }); this.sending = false; this.shouldScrollMessages = true; },
    });
  }
}
