import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ToastService } from '../shared/toast/toast.service';
import { AuthService, CreateUserDto } from '../../services/auth.service';
import { ParcelsService, Parcel } from '../../services/parcels.service';
import { OperationsService } from '../../services/operations.service';

@Component({
  selector: 'app-signup',
  standalone: true,
  imports: [FormsModule, RouterLink, CommonModule],
  templateUrl: './signup.html',
  styleUrl: './signup.css'
})
export class Signup implements OnInit {
  showPassword = false;
  isLoading = false;
  checkingParcels = false;
  anonymousParcels: Parcel[] = [];
  showParcelsFound = false;
  
  signupData: CreateUserDto = {
    name: '',
    email: '',
    password: '',
    phone: '',
    role: 'CUSTOMER',
    routesServed: []
  };

  constructor(
    private toastService: ToastService, 
    private router: Router,
    private authService: AuthService,
    private parcelsService: ParcelsService,
    private operationsService: OperationsService
  ) {}

  ngOnInit(): void {}

  togglePassword() {
    this.showPassword = !this.showPassword;
  }

  get passwordRequirements() {
    const password = this.signupData.password || '';

    return {
      minLength: password.length >= 6,
      letter: /[A-Za-z]/.test(password),
      number: /\d/.test(password),
      specialCharacter: /[^A-Za-z\d]/.test(password),
    };
  }

  // Check for anonymous parcels when email is entered
  onEmailChange() {
    if (this.signupData.email && this.isValidEmail(this.signupData.email)) {
      this.checkAnonymousParcels();
    } else {
      this.anonymousParcels = [];
      this.showParcelsFound = false;
    }
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Parcels booked for this email before the account existed are linked by the server during
   * registration, so nothing is requested here (the list is not readable without a token).
   */
  private checkAnonymousParcels() {
    this.checkingParcels = false;
    this.showParcelsFound = false;
  }

  onSubmit() {
    this.signupData.name = this.signupData.name.trim();
    this.signupData.email = this.signupData.email.trim().toLowerCase();
    this.signupData.phone = this.signupData.phone?.trim();

    // Validate form
    if (!this.signupData.name || !this.signupData.email || !this.signupData.password || !this.signupData.phone) {
      this.toastService.showError('Please fill in all required fields');
      return;
    }

    // Validate email format
    if (!this.isValidEmail(this.signupData.email)) {
      this.toastService.showError('Please enter a valid email address');
      return;
    }

    // Validate password strength
    if (!Object.values(this.passwordRequirements).every(Boolean)) {
      this.toastService.showError('Password must be at least 6 characters and include a letter, number, and special character');
      return;
    }

    // Validate name
    if (this.signupData.name.trim().length < 2) {
      this.toastService.showError('Name must be at least 2 characters long');
      return;
    }

    if (!/^\d{10}$/.test(this.signupData.phone)) {
      this.toastService.showError('Phone number must contain exactly 10 digits');
      return;
    }

    this.isLoading = true;

    // Call auth service
    const registrationData: CreateUserDto = {
      name: this.signupData.name,
      email: this.signupData.email,
      password: this.signupData.password,
      phone: this.signupData.phone,
      ...(this.signupData.address ? { address: this.signupData.address.trim() } : {}),
    };

    this.authService.register(registrationData).subscribe({
      next: (response) => {
        this.isLoading = false;
        console.log('Registration successful:', response);
        
        // Show success message with parcel linking info
        if (this.anonymousParcels.length > 0) {
          this.toastService.showSuccess(`Registration successful! ${this.anonymousParcels.length} previous parcel(s) have been linked to your account. Please login to continue.`);
        } else {
          this.toastService.showSuccess('Registration successful! Please login to continue.');
        }
        
        // Redirect based on user role
        this.redirectBasedOnRole(response.user.role);
      },
      error: (error) => {
        this.isLoading = false;
        console.error('Registration failed:', error);
        // Error is already handled by auth service with toast
      }
    });
  }

  private redirectBasedOnRole(role: string) {
    // Redirect to login page after successful registration
    this.router.navigate(['/login']);
  }
}
